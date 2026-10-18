import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { describeConfig, secretValues, type SeanceConfig } from "../config/index.ts";
import { addressFor, extractEmail, isAskerAddress, isGhostAddress, newAskerAddress, shortIdFromAddress } from "../shared/address.ts";
import { SECRET_HEADER, type AskErrorCode, type AskRequest, type AskResponse } from "../shared/api.ts";
import { lastCommitForSession, whoisLine, type WhoisResult } from "../shared/git.ts";
import type { GhostRunner, Registry } from "../shared/interfaces.ts";
import type { GhostResult, InboundEmail, QuestionRecord, SeanceEvent } from "../shared/types.ts";
import { EventBus } from "./events.ts";
import { BLOCKED_NOTICE, filterReply } from "./filter.ts";
import { formatReply, NOTICES, replySubject } from "./format.ts";
import { normalizeInbound, parseAbout, safeEqual, verifyPrimitiveSignature, type InboundMessage, type PrimitiveEvent } from "./inbound.ts";
import { isRecipientNotAllowed, type ServerMailer } from "./mailer.ts";
import { BoundedSet, OnceWithin, RateLimiter, type RateLimitOptions } from "./ratelimit.ts";

export interface AppDeps {
  config: SeanceConfig;
  registry: Registry;
  runner: GhostRunner;
  mailer: ServerMailer;
  bus?: EventBus;
  now?: () => number;
  /** Server log sink (defaults to console.log). Never receives secret values. */
  log?: (msg: string) => void;
  /** Most recent commit for a session (defaults to shared/git lastCommitForSession). */
  commitFor?: (repoPath: string, shortId: string) => Promise<string | null>;
  /** file:line -> session (defaults to shared/git whoisLine). */
  whois?: (repo: string, file: string, line: number) => Promise<WhoisResult>;
  /** Force the /api/ask path. Defaults from SEANCE_ASK_MODE and whether Primitive is configured. */
  askMode?: "email" | "in-process";
  heartbeatMs?: number;
  /** After the ghost's reply email is sent, how long to wait for it to come back through /inbound before resolving /api/ask from the pipeline result. */
  replyGraceMs?: number;
  rateLimits?: RateLimitOptions;
}

export type SeanceApp = Hono & {
  /** Resolves when all background inbound processing has finished (tests). */
  drain(): Promise<void>;
  recentQuestions(): QuestionRecord[];
};

interface Outcome {
  record?: QuestionRecord;
  commit?: string | null;
  error?: { code: AskErrorCode; message: string };
}

interface Waiter {
  resolve(o: Outcome): void;
  grace?: ReturnType<typeof setTimeout>;
}

const STATUS_FOR: Record<AskErrorCode, number> = {
  bad_request: 400, unauthorized: 401, unknown_session: 404, no_session_for_line: 404, timeout: 504, internal: 500,
};

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => { t = setTimeout(() => rej(new TimeoutError("timeout")), ms); }),
  ]).finally(() => clearTimeout(t));
}

function domainOf(addr: string): string {
  const e = extractEmail(addr);
  return e.slice(e.lastIndexOf("@") + 1);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createApp(deps: AppDeps): SeanceApp {
  const { config, registry, runner, mailer } = deps;
  const bus = deps.bus ?? new EventBus();
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(`[seance] ${m}`));
  const commitFor = deps.commitFor ?? (async (repo: string, id: string) => {
    try { return await lastCommitForSession(repo, id); } catch { return null; }
  });
  const whois = deps.whois ?? whoisLine;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const replyGraceMs = deps.replyGraceMs ?? 15_000;
  const domain = config.primitiveDomain.toLowerCase();
  const secrets = () => secretValues(config);

  const seen = new BoundedSet();
  const limiter = new RateLimiter(deps.rateLimits);
  const gateNotices = new OnceWithin(3_600_000);
  const knownAskers = new BoundedSet();
  const waiters = new Map<string, Waiter>();
  const questions = new Map<string, { record: QuestionRecord; commit?: string | null }>();
  const pending = new Set<Promise<unknown>>();

  const emit = (e: SeanceEvent) => {
    try { bus.emit(e); } catch (err) { log(`event listener failed: ${errMessage(err)}`); }
  };

  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p);
    p.finally(() => pending.delete(p)).catch(() => {});
    return p;
  };

  const remember = (record: QuestionRecord, commit?: string | null) => {
    const prev = questions.get(record.id);
    questions.delete(record.id);
    questions.set(record.id, { record, commit: commit ?? prev?.commit });
    while (questions.size > 200) questions.delete(questions.keys().next().value as string);
  };

  const patchQuestion = async (record: QuestionRecord, patch: Partial<QuestionRecord>): Promise<QuestionRecord> => {
    const next = { ...record, ...patch };
    remember(next);
    try {
      await registry.updateQuestion(record.id, patch);
    } catch (err) {
      log(`registry.updateQuestion failed for ${record.id}: ${errMessage(err)}`);
    }
    return next;
  };

  // ---- /api/ask waiters ------------------------------------------------------

  const registerWaiter = (asker: string): Promise<Outcome> =>
    new Promise<Outcome>((resolve) => { waiters.set(asker, { resolve }); });

  const settleWaiter = (asker: string, outcome: Outcome) => {
    const w = waiters.get(asker);
    if (!w) return;
    if (w.grace) clearTimeout(w.grace);
    waiters.delete(asker);
    w.resolve(outcome);
  };

  // ---- outgoing mail ---------------------------------------------------------

  /** Reply in the inbound's thread, from the address it was sent to. */
  const deliverReply = async (msg: InboundEmail, text: string) => {
    if (mailer.reply) {
      await mailer.reply(msg.messageId, text, { idempotencyKey: `reply-${msg.messageId}-${randomBytes(4).toString("hex")}` });
    } else {
      await mailer.send({ from: msg.to, to: msg.from, subject: replySubject(msg.subject), text, threadId: msg.threadId });
    }
  };

  /** Best-effort notice (gate, rate limit, unknown session). Never throws. */
  const sendNotice = async (msg: InboundEmail, text: string) => {
    try {
      await deliverReply(msg, text);
    } catch (err) {
      if (isRecipientNotAllowed(err)) log(`notice to ${msg.from} refused by Primitive recipient gate`);
      else log(`notice to ${msg.from} failed: ${errMessage(err)}`);
    }
  };

  // ---- the ghost pipeline (spec 6.4) -----------------------------------------

  const runPipeline = async (msg: InboundMessage, shortId: string, opts: { sendReply: boolean }): Promise<Outcome> => {
    const isAsker = isAskerAddress(msg.from);
    const session = await registry.getSessionByShortId(shortId);
    if (!session) {
      log(`no session for s-${shortId} (from ${msg.from})`);
      if (opts.sendReply) await sendNotice(msg, NOTICES.unknownSession);
      const outcome: Outcome = { error: { code: "unknown_session", message: `No session s-${shortId}` } };
      if (isAsker) settleWaiter(msg.from, outcome);
      return outcome;
    }

    const about = parseAbout(msg.text);
    const question = about.question || msg.subject.trim();
    let record: QuestionRecord = {
      id: `q_${randomBytes(8).toString("hex")}`,
      sessionShortId: shortId,
      from: msg.from,
      question,
      ...(about.file ? { file: about.file, line: about.line } : {}),
      threadId: msg.threadId,
      status: "received",
      createdAt: new Date(now()).toISOString(),
    };
    remember(record);
    await registry.createQuestion(record);
    emit({ type: "email_in", questionId: record.id, from: msg.from, to: msg.to });
    record = await patchQuestion(record, { status: "waking" });
    emit({ type: "ghost_waking", questionId: record.id, runner: config.ghostRunner });

    let result: GhostResult;
    let commit: string | null = null;
    try {
      let transcriptLocalPath = session.transcriptPath;
      if (session.transcriptSnapshot) {
        try {
          transcriptLocalPath = await registry.loadTranscriptSnapshot(session.transcriptSnapshot);
        } catch (err) {
          log(`snapshot load failed for s-${shortId}, falling back to original transcript: ${errMessage(err)}`);
        }
      } else {
        log(`no transcript snapshot for s-${shortId} yet, using original transcriptPath`);
      }
      const [r, c] = await Promise.all([
        runner.run({ session, transcriptLocalPath, question, from: msg.from, file: record.file, line: record.line }),
        commitFor(session.repoPath, shortId).catch(() => null),
      ]);
      result = r;
      commit = c;
    } catch (err) {
      log(`ghost run failed for ${record.id}: ${errMessage(err)}`);
      record = await patchQuestion(record, { status: "error", answeredAt: new Date(now()).toISOString() });
      emit({ type: "error", questionId: record.id, message: "ghost failed to answer" });
      if (opts.sendReply) await sendNotice(msg, NOTICES.apology);
      const outcome: Outcome = { record, error: { code: "internal", message: "The ghost failed to answer." } };
      if (isAsker) settleWaiter(msg.from, outcome);
      return outcome;
    }

    const quotes = result.quotes ?? [];
    emit({ type: "quotes_verified", questionId: record.id, verified: quotes.filter((q) => q.verified).length, total: quotes.length });

    const filtered = filterReply({ answer: result.answer ?? "", quotes }, secrets());
    const stored: GhostResult = { ...result, answer: filtered.answer, quotes: filtered.quotes };
    const text = filtered.blocked
      ? BLOCKED_NOTICE
      : formatReply({ answer: filtered.answer, quotes: filtered.quotes, shortId, commit, durationMs: result.durationMs });

    record = await patchQuestion(record, {
      status: filtered.blocked ? "blocked" : "answered",
      result: stored,
      ...(filtered.blocked ? { blockedReason: filtered.reason } : {}),
      answeredAt: new Date(now()).toISOString(),
    });
    remember(record, commit);
    if (filtered.blocked) emit({ type: "reply_blocked", questionId: record.id, reason: filtered.reason ?? "secret" });

    const outcome: Outcome = { record, commit };
    let delivered = !opts.sendReply;
    if (opts.sendReply) {
      try {
        await deliverReply(msg, text);
        delivered = true;
      } catch (err) {
        if (isRecipientNotAllowed(err)) {
          log(`reply for ${record.id} to ${msg.from} refused by Primitive recipient gate (403 recipient_not_allowed)`);
          emit({ type: "error", questionId: record.id, message: "reply refused by Primitive recipient gate" });
        } else {
          log(`reply for ${record.id} failed: ${errMessage(err)}`);
          emit({ type: "error", questionId: record.id, message: "reply email failed to send" });
        }
      }
    }
    if (delivered && !filtered.blocked) emit({ type: "reply_sent", questionId: record.id });

    if (isAsker && waiters.has(msg.from)) {
      if (delivered && opts.sendReply) {
        // Normally the reply comes back through /inbound (ask-* route). If it doesn't, resolve anyway.
        const w = waiters.get(msg.from)!;
        w.grace = setTimeout(() => settleWaiter(msg.from, outcome), replyGraceMs);
      } else {
        settleWaiter(msg.from, outcome);
      }
    }
    return outcome;
  };

  // ---- inbound routing (spec 6.3) ------------------------------------------

  const senderAllowed = (msg: InboundMessage): boolean => {
    if (config.ghostRunner === "blaxel") return true;
    const from = msg.from;
    if (isAskerAddress(from) && domainOf(from) === domain && (msg.authenticated || knownAskers.has(from))) return true;
    return msg.authenticated && config.allowedSenders.includes(from);
  };

  const handleGhostQuestion = async (msg: InboundMessage) => {
    const shortId = shortIdFromAddress(msg.to)!;
    if (isGhostAddress(msg.from) && domainOf(msg.from) === domain) {
      log(`ignoring mail from one ghost to another (${msg.from} -> ${msg.to})`);
      return;
    }
    if (!senderAllowed(msg)) {
      log(`sender gate: ${msg.from} not approved (authenticated=${msg.authenticated})`);
      if (gateNotices.first(msg.from, now())) await sendNotice(msg, NOTICES.notApproved);
      return;
    }
    const rate = limiter.check(msg.from, now());
    if (!rate.ok) {
      log(`rate limit (${rate.scope}) hit by ${msg.from}${rate.notify ? ", notifying" : ", dropping"}`);
      if (rate.notify) await sendNotice(msg, rate.scope === "sender" ? NOTICES.rateLimitedSender : NOTICES.rateLimitedGlobal);
      settleWaiter(msg.from, { error: { code: "internal", message: "Rate limited: too many questions right now." } });
      return;
    }
    await runPipeline(msg, shortId, { sendReply: true });
  };

  const handleAskerReply = async (msg: InboundMessage) => {
    const asker = msg.to;
    if (!waiters.has(asker)) {
      log(`reply to ${asker} with nobody waiting (thread ${msg.threadId})`);
      return;
    }
    const fromRegistry = await registry.getQuestionByThread(msg.threadId).catch(() => null);
    if (!fromRegistry) {
      log(`reply to ${asker}: no question for thread ${msg.threadId}, waiting for pipeline`);
      return;
    }
    const local = questions.get(fromRegistry.id);
    settleWaiter(asker, { record: local?.record ?? fromRegistry, commit: local?.commit });
  };

  const handleInbound = async (msg: InboundMessage) => {
    if (isGhostAddress(msg.to)) return handleGhostQuestion(msg);
    if (isAskerAddress(msg.to)) return handleAskerReply(msg);
    log(`ignoring mail to ${msg.to || "(no recipient)"} from ${msg.from}`);
  };

  // ---- HTTP ------------------------------------------------------------------

  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true, config: describeConfig(config) }));

  app.get("/tower", (c) => c.text("The tower page arrives in M8.", 501));

  app.post("/inbound", async (c) => {
    const raw = await c.req.text();
    const signed = verifyPrimitiveSignature(raw, c.req.header("primitive-signature"), config.primitiveWebhookSecret);
    if (!signed && !safeEqual(c.req.header(SECRET_HEADER), config.seanceSecret)) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    let evt: PrimitiveEvent;
    try {
      evt = JSON.parse(raw) as PrimitiveEvent;
    } catch {
      return c.json({ ok: false, error: "invalid JSON" }, 400);
    }
    if (evt?.event !== "email.received") return c.json({ ok: true, ignored: evt?.event ?? "unknown" });
    if (evt.id && seen.has(`evt:${evt.id}`)) return c.json({ ok: true, duplicate: true });
    let msg: InboundMessage;
    try {
      msg = normalizeInbound(evt, domain);
    } catch (err) {
      return c.json({ ok: false, error: errMessage(err) }, 400);
    }
    if (seen.has(`email:${msg.messageId}`)) return c.json({ ok: true, duplicate: true });
    if (evt.id) seen.add(`evt:${evt.id}`);
    seen.add(`email:${msg.messageId}`);

    track(handleInbound(msg).catch((err) => {
      log(`inbound processing failed: ${errMessage(err)}`);
      emit({ type: "error", message: "inbound processing failed" });
    }));
    return c.json({ ok: true });
  });

  const askError = (code: AskErrorCode, error: string) =>
    new Response(JSON.stringify({ ok: false, code, error } satisfies AskResponse), {
      status: STATUS_FOR[code],
      headers: { "content-type": "application/json" },
    });

  app.post("/api/ask", async (c) => {
    if (!safeEqual(c.req.header(SECRET_HEADER), config.seanceSecret)) return askError("unauthorized", "Missing or wrong x-seance-secret.");
    let body: AskRequest;
    try {
      body = (await c.req.json()) as AskRequest;
    } catch {
      return askError("bad_request", "Body must be JSON.");
    }
    if (!body || typeof body.question !== "string" || !body.question.trim()) return askError("bad_request", "`question` is required.");

    let shortId: string | null = null;
    let file = body.file;
    let line = body.line;
    if (body.address) {
      shortId = shortIdFromAddress(body.address);
      if (!shortId) return askError("bad_request", `Not a session address: ${body.address}`);
    } else if (body.repo && body.file && typeof body.line === "number") {
      let who: WhoisResult;
      try {
        who = await whois(body.repo, body.file, body.line);
      } catch (err) {
        return askError("no_session_for_line", `Could not blame ${body.file}:${body.line}: ${errMessage(err)}`);
      }
      if (!who.shortId) return askError("no_session_for_line", `${body.file}:${body.line} has no Agent-Session trailer.`);
      shortId = who.shortId;
      file = who.file;
      line = who.line;
    } else {
      return askError("bad_request", "Give `address`, or `repo` + `file` + `line`.");
    }

    const session = await registry.getSessionByShortId(shortId);
    if (!session) return askError("unknown_session", `No session s-${shortId} in the registry.`);

    const ghost = addressFor(shortId, domain);
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs ?? 120_000) || 120_000, 1), 600_000);
    const hasLine = Boolean(file) && typeof line === "number";
    const text = body.question.trim() + (hasLine ? `\n\nAbout: ${file}:${line}` : "");
    const subject = hasLine ? `Why is ${file}:${line} the way it is?` : `Question for s-${shortId}`;
    const mode = deps.askMode ?? (config.raw.SEANCE_ASK_MODE === "in-process" || !config.primitiveApiKey || !config.publicUrl ? "in-process" : "email");
    const asker = newAskerAddress(domain);

    let outcome: Outcome;
    try {
      if (mode === "in-process") {
        const id = `inproc-${randomBytes(8).toString("hex")}`;
        const msg: InboundMessage = {
          messageId: id, threadId: id, from: asker, to: ghost, subject, text,
          receivedAt: new Date(now()).toISOString(), authenticated: true,
        };
        outcome = await withTimeout(track(runPipeline(msg, shortId, { sendReply: false })), timeoutMs);
      } else {
        knownAskers.add(asker);
        const waiting = registerWaiter(asker);
        try {
          await mailer.send({ from: asker, to: ghost, subject, text });
        } catch (err) {
          waiters.delete(asker);
          log(`/api/ask could not send question email: ${errMessage(err)}`);
          return askError("internal", "Could not send the question email.");
        }
        try {
          outcome = await withTimeout(waiting, timeoutMs);
        } finally {
          const w = waiters.get(asker);
          if (w?.grace) clearTimeout(w.grace);
          waiters.delete(asker);
        }
      }
    } catch (err) {
      if (err instanceof TimeoutError) return askError("timeout", `No answer from s-${shortId} within ${Math.round(timeoutMs / 1000)}s.`);
      log(`/api/ask failed: ${errMessage(err)}`);
      return askError("internal", "The question could not be answered.");
    }

    if (outcome.error) return askError(outcome.error.code, outcome.error.message);
    const rec = outcome.record;
    if (!rec || !rec.result || rec.status === "error") return askError("internal", "The ghost failed to answer.");
    const res: AskResponse = {
      ok: true,
      questionId: rec.id,
      address: ghost,
      shortId,
      answer: rec.result.answer,
      quotes: rec.result.quotes,
      confidence: rec.result.confidence,
      runner: rec.result.runner,
      durationMs: rec.result.durationMs,
      ...(outcome.commit ? { commit: outcome.commit } : {}),
      blocked: rec.status === "blocked",
      ...(rec.blockedReason ? { blockedReason: rec.blockedReason } : {}),
      via: mode,
    };
    return c.json(res);
  });

  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let alive = true;
      const unsubscribe = bus.on((e) => {
        if (alive) stream.writeSSE({ data: JSON.stringify(e) }).catch(() => { alive = false; });
      });
      stream.onAbort(() => { alive = false; unsubscribe(); });
      try {
        await stream.writeSSE({ event: "snapshot", data: JSON.stringify({ questions: recentQuestions() }) });
        while (alive && !stream.aborted && !stream.closed) {
          await stream.sleep(heartbeatMs);
          if (!alive || stream.aborted) break;
          await stream.write(": heartbeat\n\n");
        }
      } finally {
        alive = false;
        unsubscribe();
      }
    }),
  );

  const recentQuestions = () => [...questions.values()].map((q) => q.record).reverse();

  const drain = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };

  return Object.assign(app, { drain, recentQuestions });
}
