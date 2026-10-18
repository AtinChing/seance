// Shared helpers for hooks/ and cli/ tests. Not a test file itself.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, SEANCE_ROOT, type SeanceConfig } from "../config/index.ts";
import type { Registry } from "../shared/interfaces.ts";
import type { QuestionRecord, SessionRecord } from "../shared/types.ts";
import type { HookContext } from "./common.ts";

export const DOMAIN = "test.example";
export const BIN = path.join(SEANCE_ROOT, "cli", "bin.js");

export function tmpDir(prefix = "seance-a-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function testConfig(dataDir: string, extra: Record<string, string> = {}): SeanceConfig {
  return loadConfig({ envFile: null, env: { PRIMITIVE_DOMAIN: DOMAIN, SEANCE_DATA_DIR: dataDir, SEANCE_SECRET: "test-secret-123456", ...extra } });
}

/** Env for child processes: inherits PATH etc. but never Claude Code / Séance flags from the test runner. */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(CLAUDECODE|CLAUDE_CODE_.*|SEANCE_.*|GIT_.*)$/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

export class TempRepo {
  readonly dir: string;
  constructor() {
    this.dir = tmpDir("seance-repo-");
    this.git("init", "-q", "-b", "main");
    this.git("config", "user.email", "human@example.com");
    this.git("config", "user.name", "Human");
    this.git("config", "commit.gpgsign", "false");
  }
  git(...args: string[]): string {
    return execFileSync("git", ["-C", this.dir, ...args], { encoding: "utf8", env: cleanEnv() }).trim();
  }
  write(rel: string, content: string): string {
    const p = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  }
  read(rel: string): string {
    return fs.readFileSync(path.join(this.dir, rel), "utf8");
  }
  /** Commit everything; `session` adds an Agent-Session trailer for that short id. */
  commit(message: string, session?: string): string {
    this.git("add", "-A");
    const msg = session ? `${message}\n\nAgent-Session: s-${session}@${DOMAIN}\nCo-Authored-By: Claude session ${session} <s-${session}@${DOMAIN}>` : message;
    this.git("commit", "-q", "-m", msg);
    return this.git("rev-parse", "HEAD");
  }
}

export class FakeRegistry implements Registry {
  sessions = new Map<string, SessionRecord>();
  questions = new Map<string, QuestionRecord>();
  snapshotDir = tmpDir("seance-snap-");
  async upsertSession(s: SessionRecord) {
    this.sessions.set(s.shortId, { ...s });
  }
  async getSessionByShortId(id: string) {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }
  async listSessions() {
    return [...this.sessions.values()];
  }
  async saveTranscriptSnapshot(sessionId: string, localPath: string) {
    const dest = path.join(this.snapshotDir, `${sessionId}.jsonl`);
    fs.copyFileSync(localPath, dest);
    return dest;
  }
  async loadTranscriptSnapshot(key: string) {
    return key;
  }
  async createQuestion(q: QuestionRecord) {
    this.questions.set(q.id, q);
  }
  async updateQuestion(id: string, patch: Partial<QuestionRecord>) {
    const q = this.questions.get(id);
    if (q) this.questions.set(id, { ...q, ...patch });
  }
  async getQuestionByThread(threadId: string) {
    return [...this.questions.values()].find((q) => q.threadId === threadId) ?? null;
  }
}

export function hookCtx(cwd: string, registry: Registry, config: SeanceConfig, env: Record<string, string | undefined> = {}): HookContext {
  return { config, env, cwd, getRegistry: async () => registry };
}

/** Session ids whose short ids are easy to read in assertions. */
export const SESSION_A = "aaaaaaaa-1111-4111-8111-111111111111";
export const SESSION_B = "bbbbbbbb-2222-4222-8222-222222222222";
