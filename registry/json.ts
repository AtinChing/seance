import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Registry } from "../shared/interfaces.ts";
import type { QuestionRecord, SessionId, SessionRecord, ShortId } from "../shared/types.ts";
import { getConfig } from "../config/index.ts";
import { withLock, type LockOptions } from "./lock.ts";

export interface RegistryState {
  version: 1;
  sessions: Record<SessionId, SessionRecord>;
  questions: Record<string, QuestionRecord>;
}

export interface JsonRegistryOptions extends LockOptions {}

/** The shared Registry contract plus read helpers every backend in this folder provides. */
export interface SeanceRegistry extends Registry {
  getSession(sessionId: SessionId): Promise<SessionRecord | null>;
  getQuestion(id: string): Promise<QuestionRecord | null>;
  listQuestions(limit?: number): Promise<QuestionRecord[]>;
}

const emptyState = (): RegistryState => ({ version: 1, sessions: {}, questions: {} });

/** Drop keys whose value is undefined, so a merge never wipes an existing field by omission. */
function defined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

const time = (s: string | undefined) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Registry backed by `<dataDir>/registry.json` plus `<dataDir>/transcripts/`.
 * Safe for several processes at once: nothing is cached, every write is temp+rename,
 * and read-modify-write sections hold a mkdir lock (`<dataDir>/registry.lock`).
 */
export class JsonRegistry implements SeanceRegistry {
  readonly dataDir: string;
  readonly file: string;
  readonly lockDir: string;
  readonly transcriptsDir: string;
  private readonly lockOpts: LockOptions;

  constructor(dataDir?: string, opts: JsonRegistryOptions = {}) {
    this.dataDir = path.resolve(dataDir ?? getConfig().dataDir);
    this.file = path.join(this.dataDir, "registry.json");
    this.lockDir = path.join(this.dataDir, "registry.lock");
    this.transcriptsDir = path.join(this.dataDir, "transcripts");
    this.lockOpts = { timeoutMs: opts.timeoutMs, staleMs: opts.staleMs };
  }

  // ---------- sessions ----------

  async upsertSession(s: SessionRecord): Promise<void> {
    if (!s?.sessionId) throw new Error("upsertSession: sessionId is required");
    await this.mutate((st) => {
      const prev = st.sessions[s.sessionId];
      st.sessions[s.sessionId] = { ...(prev ?? {}), ...defined(s) } as SessionRecord;
    });
  }

  async getSession(sessionId: SessionId): Promise<SessionRecord | null> {
    return (await this.read()).sessions[sessionId] ?? null;
  }

  async getSessionByShortId(shortId: ShortId): Promise<SessionRecord | null> {
    const want = shortId.trim().toLowerCase();
    if (!want) return null;
    const matches = Object.values((await this.read()).sessions).filter((s) => s.shortId?.toLowerCase() === want);
    if (!matches.length) return null;
    matches.sort((a, b) => time(b.startedAt) - time(a.startedAt));
    return matches[0];
  }

  /** All sessions, most recently started first. */
  async listSessions(): Promise<SessionRecord[]> {
    return Object.values((await this.read()).sessions).sort((a, b) => time(b.startedAt) - time(a.startedAt));
  }

  // ---------- transcripts ----------

  snapshotPath(sessionId: SessionId): string {
    if (!SAFE_ID.test(sessionId)) throw new Error(`Invalid sessionId for a snapshot file name: ${JSON.stringify(sessionId)}`);
    return path.join(this.transcriptsDir, `${sessionId}.jsonl`);
  }

  /**
   * Copy the live transcript to a frozen, read-only snapshot and return its absolute path (the key).
   * The source is only read. If the session is registered, its `transcriptSnapshot` is set too.
   */
  async saveTranscriptSnapshot(sessionId: SessionId, localPath: string): Promise<string> {
    const dest = this.snapshotPath(sessionId);
    const src = path.resolve(localPath);
    if (!existsSync(src)) throw new Error(`Cannot snapshot session ${sessionId}: transcript not found at ${src}`);
    await fs.mkdir(this.transcriptsDir, { recursive: true });
    const tmp = `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.copyFile(src, tmp);
      await fs.chmod(tmp, 0o444);
      await fs.rename(tmp, dest); // replaces an older (read-only) snapshot atomically
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    await this.mutate((st) => {
      const rec = st.sessions[sessionId];
      if (rec) rec.transcriptSnapshot = dest;
    });
    return dest;
  }

  /** Accepts the key returned by saveTranscriptSnapshot (an absolute path) or a bare sessionId. */
  async loadTranscriptSnapshot(key: string): Promise<string> {
    if (!key) throw new Error("loadTranscriptSnapshot: empty key");
    const candidate = path.isAbsolute(key) ? key : SAFE_ID.test(key) ? this.snapshotPath(key.replace(/\.jsonl$/, "")) : path.resolve(this.dataDir, key);
    if (!existsSync(candidate)) {
      throw new Error(`Transcript snapshot not found: ${candidate} (key ${JSON.stringify(key)}). Was the session snapshotted? Try \`seance snapshot <shortId>\`.`);
    }
    return candidate;
  }

  // ---------- questions ----------

  async createQuestion(q: QuestionRecord): Promise<void> {
    if (!q?.id) throw new Error("createQuestion: id is required");
    await this.mutate((st) => {
      if (st.questions[q.id]) throw new Error(`createQuestion: question ${q.id} already exists`);
      st.questions[q.id] = { ...q };
    });
  }

  async updateQuestion(id: string, patch: Partial<QuestionRecord>): Promise<void> {
    await this.mutate((st) => {
      const prev = st.questions[id];
      if (!prev) throw new Error(`updateQuestion: unknown question id ${id}`);
      st.questions[id] = { ...prev, ...defined(patch), id };
    });
  }

  async getQuestion(id: string): Promise<QuestionRecord | null> {
    return (await this.read()).questions[id] ?? null;
  }

  async getQuestionByThread(threadId: string): Promise<QuestionRecord | null> {
    const matches = Object.values((await this.read()).questions).filter((q) => q.threadId === threadId);
    if (!matches.length) return null;
    matches.sort((a, b) => time(b.createdAt) - time(a.createdAt));
    return matches[0];
  }

  /** Questions newest first. */
  async listQuestions(limit?: number): Promise<QuestionRecord[]> {
    const all = Object.values((await this.read()).questions).sort((a, b) => time(b.createdAt) - time(a.createdAt));
    return limit === undefined ? all : all.slice(0, Math.max(0, limit));
  }

  // ---------- storage ----------

  /** Read current state. Lock-free (writes are atomic renames); a corrupt file is repaired under the lock. */
  private async read(): Promise<RegistryState> {
    const r = await this.load();
    if (r.ok) return r.state;
    return withLock(this.lockDir, async () => this.loadOrRepair(), this.lockOpts);
  }

  /** Read-modify-write under the cross-process lock. */
  private async mutate(fn: (st: RegistryState) => void): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await withLock(this.lockDir, async () => {
      const st = await this.loadOrRepair();
      fn(st);
      await this.write(st);
    }, this.lockOpts);
  }

  /** Must be called while holding the lock. */
  private async loadOrRepair(): Promise<RegistryState> {
    const r = await this.load();
    if (r.ok) return r.state;
    const aside = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(2).toString("hex")}`;
    try {
      await fs.rename(this.file, aside);
      console.warn(`[seance registry] ${this.file} was corrupt (${r.error}); moved aside to ${aside} and starting empty`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return emptyState();
  }

  private async load(): Promise<{ ok: true; state: RegistryState } | { ok: false; error: string }> {
    let text: string;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, state: emptyState() };
      throw err;
    }
    if (!text.trim()) return { ok: true, state: emptyState() };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "not a JSON object" };
    const p = parsed as Partial<RegistryState>;
    const isMap = (v: unknown) => v === undefined || (typeof v === "object" && v !== null && !Array.isArray(v));
    if (!isMap(p.sessions) || !isMap(p.questions)) return { ok: false, error: "sessions/questions are not objects" };
    return { ok: true, state: { version: 1, sessions: p.sessions ?? {}, questions: p.questions ?? {} } };
  }

  private async write(st: RegistryState): Promise<void> {
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(st, null, 2) + "\n");
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}
