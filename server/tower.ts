// GET /tower: the big-screen live view (spec 6.10, demo run order step 3).
// GET /tower/questions.json: the public, privacy-safe view of recent questions it renders.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { secretValues, type SeanceConfig } from "../config/index.ts";
import { addressFor, extractEmail, isAskerAddress, isGhostAddress } from "../shared/address.ts";
import type { QuestionRecord, SeanceEvent, SessionRecord } from "../shared/types.ts";
import type { EventBus } from "./events.ts";
import { RULES, scanText } from "./filter.ts";

export interface TowerDeps {
  recentQuestions: () => QuestionRecord[];
  bus: EventBus;
  config: SeanceConfig;
  /** Optional: lets the header show the newest session's address before anyone has asked. */
  registry?: { listSessions(): Promise<SessionRecord[]> };
  now?: () => number;
}

/** How the reply email fared, as seen on the event bus. */
export type Delivery = "pending" | "sent" | "refused" | "failed" | "unknown";

export interface TowerQuestion {
  id: string;
  session: string;                  // s-xxxxxxxx
  from: string;                     // masked, or "seance ask (CLI/agent)"
  fromKind: "person" | "agent";
  question: string;
  file?: string;
  line?: number;
  status: QuestionRecord["status"];
  createdAt: string;
  answeredAt?: string;
  answer?: string;
  quotes?: { text: string; verified: boolean }[];
  /** From the quotes_verified event (counted before the outbound filter), else from the stored quotes. */
  verified?: number;
  total?: number;
  confidence?: "high" | "medium" | "low";
  runner?: "local" | "blaxel";
  durationMs?: number;
  testOutput?: string;
  blockedRule?: string;
  delivery: Delivery;
}

export interface TowerPayload {
  questions: TowerQuestion[];
  addresses: string[];
  serverNow: number;
}

export const ASKER_LABEL = "seance ask (CLI/agent)";
const MAX_QUESTIONS = 50;
const MAX_QUESTION_CHARS = 2000;
const MAX_TEST_OUTPUT_CHARS = 1200;

/** "Atin <atin@gmail.com>" -> "a***@gmail.com". Our own ask-* addresses become a label. */
export function maskSender(from: string): { label: string; kind: "person" | "agent" } {
  if (isAskerAddress(from)) return { label: ASKER_LABEL, kind: "agent" };
  const email = extractEmail(from);
  const at = email.lastIndexOf("@");
  if (at <= 0) return { label: "someone", kind: "person" };
  const domain = email.slice(at + 1).replace(/[^a-z0-9.-]/g, "");
  return { label: `${email[0]}***@${domain || "?"}`, kind: "person" };
}

const RULE_NAMES = new Set([...RULES.map((r) => r.name), "env_value"]);

/** blockedReason is "<rule> in <where>"; only a known rule name ever leaves, never matched text. */
export function ruleName(reason: string | undefined): string {
  const first = (reason ?? "").trim().split(/\s+/)[0];
  return RULE_NAMES.has(first) ? first : "secret";
}

const SHORT_RE = /^[0-9a-f]{8}$/i;

const towerHtmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "tower.html");
/** Read per request (it's small) so edits to tower.html show up on reload. */
function towerHtml(): string {
  return fs.readFileSync(towerHtmlPath, "utf8");
}

export function registerTowerRoutes(app: Hono, deps: TowerDeps): void {
  const { config, bus } = deps;
  const now = deps.now ?? Date.now;
  const domain = config.primitiveDomain.toLowerCase();

  // Per-question facts that only travel on the bus (QuestionRecord doesn't carry them).
  const delivery = new Map<string, Delivery>();
  const counts = new Map<string, { verified: number; total: number }>();
  const forget = <V>(m: Map<string, V>) => { while (m.size > 500) m.delete(m.keys().next().value as string); };

  bus.on((e: SeanceEvent) => {
    switch (e.type) {
      case "quotes_verified":
        counts.set(e.questionId, { verified: e.verified, total: e.total });
        forget(counts);
        break;
      case "reply_sent":
        delivery.set(e.questionId, "sent");
        break;
      case "error":
        if (e.questionId) delivery.set(e.questionId, /recipient gate/i.test(e.message) ? "refused" : "failed");
        break;
      default:
        break;
    }
    forget(delivery);
  });

  const toView = (q: QuestionRecord): TowerQuestion => {
    const who = maskSender(q.from);
    const r = q.result;
    const c = counts.get(q.id);
    const quotes = r?.quotes?.map((x) => ({ text: String(x.text), verified: Boolean(x.verified) }));
    let testOutput: string | undefined;
    if (r?.testOutput && q.status === "answered") {
      const tail = r.testOutput.slice(-MAX_TEST_OUTPUT_CHARS);
      if (!scanText(tail, secretValues(config))) testOutput = tail;
    }
    let d: Delivery = delivery.get(q.id) ?? "unknown";
    if (d === "unknown" && (q.status === "received" || q.status === "waking")) d = "pending";
    // reply_sent follows the "answered" patch by one send call; a fresh answer with no news yet is still sending.
    if (d === "unknown" && q.status === "answered" && (!q.answeredAt || now() - Date.parse(q.answeredAt) < 60_000)) d = "pending";
    return {
      id: q.id,
      session: `s-${q.sessionShortId}`,
      from: who.label,
      fromKind: who.kind,
      question: q.question.slice(0, MAX_QUESTION_CHARS),
      ...(q.file ? { file: q.file, ...(typeof q.line === "number" ? { line: q.line } : {}) } : {}),
      status: q.status,
      createdAt: q.createdAt,
      ...(q.answeredAt ? { answeredAt: q.answeredAt } : {}),
      // A blocked record stores the blocked notice as its answer and no quotes; the page shows its own banner.
      ...(r && q.status !== "blocked" ? { answer: r.answer, quotes } : {}),
      ...(c ? c : quotes && q.status !== "blocked" ? { verified: quotes.filter((x) => x.verified).length, total: quotes.length } : {}),
      ...(r ? { confidence: r.confidence, runner: r.runner, durationMs: r.durationMs } : {}),
      ...(testOutput ? { testOutput } : {}),
      ...(q.status === "blocked" ? { blockedRule: ruleName(q.blockedReason) } : {}),
      delivery: d,
    };
  };

  const addresses = async (questions: QuestionRecord[]): Promise<string[]> => {
    if (!domain) return [];
    // The session of the newest question, else the newest session in the registry.
    const ids: string[] = [];
    const newest = questions.find((q) => SHORT_RE.test(q.sessionShortId));
    if (newest) ids.push(newest.sessionShortId.toLowerCase());
    if (!ids.length && deps.registry) {
      try {
        const sessions = (await deps.registry.listSessions()).filter((s) => SHORT_RE.test(s.shortId));
        const ts = (s: SessionRecord) => Date.parse(s.endedAt ?? s.startedAt) || 0;
        sessions.sort((a, b) => ts(b) - ts(a));
        if (sessions[0]) ids.push(sessions[0].shortId);
      } catch {
        // header falls back to ?address= or nothing
      }
    }
    return ids.map((id) => addressFor(id, domain)).filter(isGhostAddress);
  };

  app.get("/tower", (c) => {
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header(
      "content-security-policy",
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    return c.html(towerHtml());
  });

  app.get("/tower/questions.json", async (c) => {
    // recentQuestions() is ordered by last update; the tower wants newest first by arrival.
    const recent = [...deps.recentQuestions()]
      .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
      .slice(0, MAX_QUESTIONS);
    const payload: TowerPayload = {
      questions: recent.map(toView),
      addresses: await addresses(recent),
      serverNow: now(),
    };
    c.header("cache-control", "no-store");
    return c.json(payload);
  });
}
