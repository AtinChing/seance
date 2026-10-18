// Fakes and builders shared by server tests. Not a test file itself.
import { randomBytes } from "node:crypto";
import { signWebhookPayload } from "@primitivedotdev/sdk/webhook";
import { loadConfig, type SeanceConfig } from "../config/index.ts";
import type { GhostRunner, Registry } from "../shared/interfaces.ts";
import type { GhostResult, QuestionRecord, SeanceEvent, SessionRecord } from "../shared/types.ts";
import { createApp, type AppDeps, type SeanceApp } from "./app.ts";
import { EventBus } from "./events.ts";
import type { ReplyOptions, ServerMailer } from "./mailer.ts";

export const DOMAIN = "example.primitive.email";
export const SEANCE_SECRET = "test-seance-secret-0123456789abcdef";
export const WEBHOOK_SECRET = "whsec_test_0123456789abcdef";
export const API_KEY = "prim_test_key_abcdef1234567890";
export const ALLOWED = "asker.example@gmail.com";
export const SHORT = "7f3a1b2c";
export const GHOST = `s-${SHORT}@${DOMAIN}`;

export function testConfig(env: Record<string, string> = {}): SeanceConfig {
  return loadConfig({
    envFile: null,
    env: {
      PRIMITIVE_DOMAIN: DOMAIN,
      SEANCE_SECRET,
      PRIMITIVE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PRIMITIVE_API_KEY: API_KEY,
      ALLOWED_SENDERS: ALLOWED,
      GHOST_RUNNER: "local",
      PUBLIC_URL: "https://seance.example.test",
      ...env,
    },
  });
}

export function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: `${SHORT}-1111-2222-3333-444455556666`,
    shortId: SHORT,
    address: GHOST,
    repoPath: "/nonexistent/repo",
    transcriptPath: "/original/transcript.jsonl",
    transcriptSnapshot: "snap-key",
    startedAt: "2026-10-18T00:00:00.000Z",
    ...over,
  };
}

export class FakeRegistry implements Registry {
  sessions = new Map<string, SessionRecord>();
  questions = new Map<string, QuestionRecord>();
  snapshotLoads: string[] = [];
  failSnapshot = false;
  constructor(...ss: SessionRecord[]) { for (const s of ss) this.sessions.set(s.shortId, s); }
  async upsertSession(s: SessionRecord) { this.sessions.set(s.shortId, s); }
  async getSessionByShortId(id: string) { return this.sessions.get(id) ?? null; }
  async listSessions() { return [...this.sessions.values()]; }
  async saveTranscriptSnapshot(_id: string, p: string) { return p; }
  async loadTranscriptSnapshot(key: string) {
    this.snapshotLoads.push(key);
    if (this.failSnapshot) throw new Error("snapshot gone");
    return `/snapshots/${key}.jsonl`;
  }
  async createQuestion(q: QuestionRecord) { this.questions.set(q.id, { ...q }); }
  async updateQuestion(id: string, patch: Partial<QuestionRecord>) {
    const q = this.questions.get(id);
    if (q) this.questions.set(id, { ...q, ...patch });
  }
  async getQuestionByThread(threadId: string) {
    return [...this.questions.values()].find((q) => q.threadId === threadId) ?? null;
  }
  only(): QuestionRecord {
    const all = [...this.questions.values()];
    if (all.length !== 1) throw new Error(`expected 1 question, got ${all.length}`);
    return all[0];
  }
}

export function ghostResult(over: Partial<GhostResult> = {}): GhostResult {
  return {
    answer: "0.25 caused double charges, so I picked 0.37.",
    quotes: [
      { text: "delay 0.25: 2 charges", verified: true },
      { text: "I think 0.37 is safe", verified: false },
    ],
    confidence: "high",
    runId: "run-1",
    runner: "local",
    durationMs: 12_400,
    ...over,
  };
}

export class FakeRunner implements GhostRunner {
  calls: Parameters<GhostRunner["run"]>[0][] = [];
  constructor(public impl: () => Promise<GhostResult> | GhostResult = () => ghostResult()) {}
  async run(input: Parameters<GhostRunner["run"]>[0]) {
    this.calls.push(input);
    return this.impl();
  }
}

export interface SentMail { from: string; to: string; subject: string; text: string }
export interface ReplyMail { inboundEmailId: string; text: string; opts?: ReplyOptions }

export class FakeMailer implements ServerMailer {
  sent: SentMail[] = [];
  replies: ReplyMail[] = [];
  replyError?: Error;
  sendError?: Error;
  onSend?: (m: SentMail, id: string) => void;
  onReply?: (r: ReplyMail, id: string) => void;
  async send(input: SentMail) {
    if (this.sendError) throw this.sendError;
    this.sent.push(input);
    const id = `sent-${this.sent.length}`;
    this.onSend?.(input, id);
    return { messageId: id, threadId: id };
  }
  async reply(inboundEmailId: string, text: string, opts?: ReplyOptions) {
    if (this.replyError) throw this.replyError;
    const r = { inboundEmailId, text, opts };
    this.replies.push(r);
    const id = `reply-${this.replies.length}`;
    this.onReply?.(r, id);
    return { messageId: id, threadId: inboundEmailId };
  }
}

export interface EventOpts {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  threadId?: string;
  emailId?: string;
  eventId?: string;
  authenticated?: boolean;
  event?: string;
}

/** A Primitive email.received event in the shape captured in M0 (shared/fixtures). */
export function makeEvent(o: EventOpts = {}) {
  const emailId = o.emailId ?? `em-${randomBytes(6).toString("hex")}`;
  const to = o.to ?? GHOST;
  return {
    id: o.eventId ?? `evt_${randomBytes(8).toString("hex")}`,
    event: o.event ?? "email.received",
    version: "2025-12-14",
    email: {
      id: emailId,
      received_at: "2026-10-18T08:10:11.237Z",
      smtp: { mail_from: o.from ?? ALLOWED, rcpt_to: [to] },
      headers: { subject: o.subject ?? "why 0.37?", from: `Test Asker <${o.from ?? ALLOWED}>`, to },
      parsed: { body_text: o.text ?? "Why is the retry delay 0.37?\n", to_addresses: [{ address: to, name: null }] },
      analysis: { sender: { authenticated: o.authenticated ?? true, basis: "dmarc_aligned" } },
      thread_id: o.threadId ?? `th-${emailId}`,
    },
  };
}

export type TestApp = SeanceApp;

export function build(over: Partial<AppDeps> & { env?: Record<string, string> } = {}) {
  const config = over.config ?? testConfig(over.env);
  const registry = (over.registry as FakeRegistry) ?? new FakeRegistry(session());
  const runner = (over.runner as FakeRunner) ?? new FakeRunner();
  const mailer = (over.mailer as FakeMailer) ?? new FakeMailer();
  const bus = over.bus ?? new EventBus();
  const events: SeanceEvent[] = [];
  bus.on((e) => events.push(e));
  const logs: string[] = [];
  const app = createApp({
    commitFor: async () => "abcdef0123456789abcdef0123456789abcdef01",
    log: (m) => logs.push(m),
    ...over,
    config, registry, runner, mailer, bus,
  });
  return { app, config, registry, runner, mailer, bus, events, logs };
}

export async function postSigned(app: SeanceApp, body: unknown, secret = WEBHOOK_SECRET, timestamp?: number) {
  const raw = JSON.stringify(body);
  const sig = signWebhookPayload(raw, secret, timestamp);
  return app.request("/inbound", { method: "POST", headers: { "content-type": "application/json", "Primitive-Signature": sig.header }, body: raw });
}

export async function postWithSecret(app: SeanceApp, body: unknown, secret = SEANCE_SECRET) {
  return app.request("/inbound", { method: "POST", headers: { "content-type": "application/json", "x-seance-secret": secret }, body: JSON.stringify(body) });
}

export async function ask(app: SeanceApp, body: unknown, secret: string | null = SEANCE_SECRET) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-seance-secret"] = secret;
  return app.request("/api/ask", { method: "POST", headers, body: JSON.stringify(body) });
}
