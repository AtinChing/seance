import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { QuestionRecord, SessionId, SessionRecord, ShortId } from "../shared/types.ts";
import type { SeanceRegistry } from "./json.ts";

/**
 * InsForge-backed registry (SPEC 6.8).
 *
 * Talks to the InsForge REST API directly with fetch (no SDK) so every call has a hard timeout,
 * errors never echo the API key, and tests can swap in a fake fetch:
 *   - rows:      /api/database/records/{table}   (PostgREST-style filters, Prefer headers)
 *   - snapshots: /api/storage/buckets/transcripts (upload-strategy / download-strategy, direct or presigned)
 * Schema lives in registry/insforge-setup.ts.
 */

export const SESSIONS_TABLE = "sessions";
export const QUESTIONS_TABLE = "questions";
export const TRANSCRIPTS_BUCKET = "transcripts";
export const KEY_PREFIX = "insforge:";

/** Metadata calls (rows, strategies, listings). Hooks run inside Claude Code sessions, so keep this short. */
export const DEFAULT_TIMEOUT_MS = 5_000;
/** Moving a transcript body (can be a few MB). */
export const DEFAULT_TRANSFER_TIMEOUT_MS = 30_000;

const PAGE = 1000; // records API max limit
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface InsForgeOptions {
  url: string;
  apiKey: string;
  /** Local cache for downloaded snapshots lives in <dataDir>/transcript-cache. */
  dataDir: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  transferTimeoutMs?: number;
}

export class InsForgeError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "InsForgeError";
  }
}

type Query = Record<string, string | number | undefined>;

interface RequestOpts {
  query?: Query;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** false for absolute URLs that must not get our bearer token (presigned S3). */
  auth?: boolean;
  /** Retry once on network error / 5xx. Only for idempotent calls. */
  retry?: boolean;
}

/** Thin, timeout-guarded InsForge REST client. Shared by the registry, setup script and migrate. */
export class InsForgeHttp {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  readonly timeoutMs: number;
  readonly transferTimeoutMs: number;

  constructor(opts: { url: string; apiKey: string; fetch?: FetchLike; timeoutMs?: number; transferTimeoutMs?: number }) {
    if (!opts.url) throw new Error("InsForge: url is required (INSFORGE_URL)");
    if (!opts.apiKey) throw new Error("InsForge: apiKey is required (INSFORGE_API_KEY)");
    this.baseUrl = opts.url.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transferTimeoutMs = opts.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
  }

  url(p: string, query?: Query): string {
    const u = /^https?:\/\//i.test(p) ? new URL(p) : new URL(this.baseUrl + (p.startsWith("/") ? p : `/${p}`));
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.append(k, String(v));
    return u.toString();
  }

  /** Raw request: returns the Response for 2xx, throws InsForgeError otherwise. */
  async raw(method: string, p: string, opts: RequestOpts = {}): Promise<Response> {
    const attempts = opts.retry ? 2 : 1;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await this.once(method, p, opts);
        if (res.status >= 500 && i + 1 < attempts) {
          await res.body?.cancel().catch(() => {});
          last = new InsForgeError(`InsForge ${method} ${this.label(p)}: HTTP ${res.status}`, res.status);
          continue;
        }
        if (!res.ok) throw await this.toError(method, p, res);
        return res;
      } catch (err) {
        last = err;
        const retryable = !(err instanceof InsForgeError) || err.status >= 500 || err.status === 0;
        if (!retryable || i + 1 >= attempts) throw err;
      }
    }
    throw last;
  }

  /** JSON request: returns the parsed body (or null for an empty body). */
  async json<T = unknown>(method: string, p: string, opts: RequestOpts = {}): Promise<T> {
    const res = await this.raw(method, p, opts);
    const text = await res.text();
    if (!text.trim()) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new InsForgeError(`InsForge ${method} ${this.label(p)}: response was not JSON`, res.status);
    }
  }

  private async once(method: string, p: string, opts: RequestOpts): Promise<Response> {
    const absolute = /^https?:\/\//i.test(p);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.auth !== false && (!absolute || p.startsWith(this.baseUrl))) headers.Authorization = `Bearer ${this.apiKey}`;
    let body = opts.body;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(this.url(p, opts.query), { method, headers, body, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new InsForgeError(`InsForge ${method} ${this.label(p)} timed out after ${timeoutMs} ms`, 0, "TIMEOUT");
      throw new InsForgeError(`InsForge ${method} ${this.label(p)} failed: ${(err as Error)?.message ?? String(err)}`, 0, "NETWORK");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Path without query string or host, for error messages (never includes the key). */
  private label(p: string): string {
    try {
      return /^https?:\/\//i.test(p) ? new URL(p).host + "/…" : p;
    } catch {
      return "(url)";
    }
  }

  private async toError(method: string, p: string, res: Response): Promise<InsForgeError> {
    let detail = "";
    let code: string | undefined;
    try {
      const text = await res.text();
      try {
        const j = JSON.parse(text) as { message?: string; error?: string; code?: string; details?: string; hint?: string };
        code = j.code ?? j.error;
        detail = [j.error, j.code, j.message, j.details].filter(Boolean).join(": ");
      } catch {
        detail = text.slice(0, 200);
      }
    } catch {
      /* ignore */
    }
    return new InsForgeError(`InsForge ${method} ${this.label(p)}: HTTP ${res.status}${detail ? ` ${detail}` : ""}`, res.status, code);
  }

  // ---------- records (PostgREST-style) ----------

  async select<T = Record<string, unknown>>(table: string, query: Query = {}): Promise<T[]> {
    const rows = await this.json<T[]>("GET", `/api/database/records/${table}`, { query: { select: "*", ...query }, retry: true });
    return Array.isArray(rows) ? rows : [];
  }

  /** Every row matching `query`, paging past the API's 1000-row limit. */
  async selectAll<T = Record<string, unknown>>(table: string, query: Query = {}): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.select<T>(table, { ...query, limit: PAGE, offset });
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  }

  async insert(table: string, rows: Record<string, unknown>[]): Promise<void> {
    await this.raw("POST", `/api/database/records/${table}`, { json: rows, headers: { Prefer: "return=minimal" } });
  }

  /** INSERT ... ON CONFLICT (onConflict) DO UPDATE SET <only the columns sent>. Omitted columns keep their values. */
  async upsert(table: string, rows: Record<string, unknown>[], onConflict: string): Promise<void> {
    await this.raw("POST", `/api/database/records/${table}`, {
      query: { on_conflict: onConflict },
      json: rows,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      retry: true,
    });
  }

  /** PATCH rows matching `filter`; returns the updated rows. */
  async update<T = Record<string, unknown>>(table: string, filter: Query, patch: Record<string, unknown>): Promise<T[]> {
    const rows = await this.json<T[]>("PATCH", `/api/database/records/${table}`, {
      query: filter,
      json: patch,
      headers: { Prefer: "return=representation" },
      retry: true,
    });
    return Array.isArray(rows) ? rows : [];
  }

  async delete(table: string, filter: Query): Promise<void> {
    await this.raw("DELETE", `/api/database/records/${table}`, { query: filter, headers: { Prefer: "return=minimal" } });
  }

  // ---------- storage ----------

  /** Upload (create or replace) an object at an exact key, following the backend's upload strategy. */
  async uploadObject(bucket: string, key: string, data: Uint8Array, contentType = "application/x-ndjson"): Promise<{ key: string; size?: number }> {
    const strategy = await this.json<{
      method: "direct" | "presigned";
      uploadUrl: string;
      fields?: Record<string, string>;
      key: string;
      confirmRequired?: boolean;
      confirmUrl?: string;
    }>("POST", `/api/storage/buckets/${bucket}/upload-strategy`, { json: { filename: key, contentType, size: data.byteLength } });
    if (!strategy?.method || !strategy.uploadUrl) throw new InsForgeError("InsForge upload-strategy: unexpected response", 500);
    const blob = new Blob([new Uint8Array(data)], { type: contentType });
    const t = this.transferTimeoutMs;
    if (strategy.method === "direct") {
      const form = new FormData();
      form.append("file", blob, path.basename(key));
      const stored = await this.json<{ key?: string; size?: number }>("PUT", strategy.uploadUrl, { body: form, timeoutMs: t });
      return { key: stored?.key ?? strategy.key ?? key, size: stored?.size };
    }
    if (strategy.method === "presigned") {
      const form = new FormData();
      for (const [k, v] of Object.entries(strategy.fields ?? {})) form.append(k, v);
      form.append("file", blob, path.basename(key));
      await this.raw("POST", strategy.uploadUrl, { body: form, timeoutMs: t, auth: false });
      if (strategy.confirmRequired && strategy.confirmUrl) {
        await this.json("POST", strategy.confirmUrl, { json: { size: data.byteLength, contentType } });
      }
      return { key: strategy.key ?? key, size: data.byteLength };
    }
    throw new InsForgeError(`InsForge upload-strategy: unsupported method ${String((strategy as { method: unknown }).method)}`, 500);
  }

  /** Download an object's bytes, following the backend's download strategy. */
  async downloadObject(bucket: string, key: string): Promise<Uint8Array> {
    const enc = encodeURIComponent(key);
    const strategy = await this.json<{ method: "direct" | "presigned"; url: string; headers?: Record<string, string> }>(
      "GET",
      `/api/storage/buckets/${bucket}/download-strategy/objects/${enc}`,
      { retry: true },
    );
    if (!strategy?.url) throw new InsForgeError("InsForge download-strategy: unexpected response", 500);
    const res = await this.raw("GET", strategy.url, {
      headers: strategy.headers,
      auth: strategy.method !== "presigned",
      timeoutMs: this.transferTimeoutMs,
      retry: true,
    });
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Size of one object, or null when it does not exist. */
  async objectSize(bucket: string, key: string): Promise<number | null> {
    const res = await this.json<{ data?: { key: string; size: number }[] } | { key: string; size: number }[]>(
      "GET",
      `/api/storage/buckets/${bucket}/objects`,
      { query: { prefix: key, limit: 100 }, retry: true },
    );
    const list = Array.isArray(res) ? res : (res?.data ?? []);
    const hit = list.find((o) => o.key === key);
    return hit ? Number(hit.size) : null;
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.raw("DELETE", `/api/storage/buckets/${bucket}/objects/${encodeURIComponent(key)}`);
  }
}

// ---------- row mapping ----------

type Row = Record<string, unknown>;

const SESSION_COLUMNS: [keyof SessionRecord, string][] = [
  ["sessionId", "session_id"],
  ["shortId", "short_id"],
  ["address", "address"],
  ["repoPath", "repo_path"],
  ["transcriptPath", "transcript_path"],
  ["transcriptSnapshot", "transcript_snapshot"],
  ["startedAt", "started_at"],
  ["endedAt", "ended_at"],
];

const QUESTION_COLUMNS: [keyof QuestionRecord, string][] = [
  ["id", "id"],
  ["sessionShortId", "session_short_id"],
  ["from", "from_address"],
  ["question", "question"],
  ["file", "file"],
  ["line", "line"],
  ["threadId", "thread_id"],
  ["status", "status"],
  ["result", "result"],
  ["blockedReason", "blocked_reason"],
  ["createdAt", "created_at"],
  ["answeredAt", "answered_at"],
];

/** Record -> row. Undefined fields are left out, so an upsert/patch never wipes a column by omission. */
function toRow<T extends object>(rec: Partial<T>, cols: [keyof T, string][]): Row {
  const row: Row = {};
  for (const [field, col] of cols) {
    const v = rec[field];
    if (v !== undefined) row[col] = v;
  }
  return row;
}

/** Row -> record. Null columns become absent fields, matching the JSON registry's shape. */
function fromRow<T>(row: Row, cols: [keyof T, string][]): T {
  const rec: Record<string, unknown> = {};
  for (const [field, col] of cols) {
    const v = row[col];
    if (v !== null && v !== undefined) rec[field as string] = v;
  }
  return rec as T;
}

export const sessionToRow = (s: Partial<SessionRecord>) => toRow(s, SESSION_COLUMNS);
export const rowToSession = (r: Row) => fromRow<SessionRecord>(r, SESSION_COLUMNS);
export const questionToRow = (q: Partial<QuestionRecord>) => toRow(q, QUESTION_COLUMNS);
export const rowToQuestion = (r: Row) => fromRow<QuestionRecord>(r, QUESTION_COLUMNS);

const time = (s: string | undefined) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

/** "insforge:transcripts/<id>.jsonl" -> { bucket, objectKey }, or null for anything else. */
export function parseSnapshotKey(key: string): { bucket: string; objectKey: string } | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const rest = key.slice(KEY_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const bucket = rest.slice(0, slash);
  const objectKey = rest.slice(slash + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(bucket) || !objectKey || objectKey.split("/").some((p) => !p || p === "." || p === "..")) return null;
  return { bucket, objectKey };
}

export const snapshotKeyFor = (sessionId: SessionId) => `${KEY_PREFIX}${TRANSCRIPTS_BUCKET}/${sessionId}.jsonl`;

const isDuplicate = (err: unknown) =>
  err instanceof InsForgeError && (err.status === 409 || err.code === "23505" || /duplicate key|already exists/i.test(err.message));

/**
 * Registry stored in InsForge: tables `sessions` and `questions`, bucket `transcripts`.
 * Same semantics as JsonRegistry (see registry/json.ts).
 */
export class InsForgeRegistry implements SeanceRegistry {
  readonly http: InsForgeHttp;
  readonly dataDir: string;
  readonly cacheDir: string;

  constructor(opts: InsForgeOptions) {
    this.http = new InsForgeHttp(opts);
    this.dataDir = path.resolve(opts.dataDir);
    this.cacheDir = path.join(this.dataDir, "transcript-cache");
  }

  // ---------- sessions ----------

  async upsertSession(s: SessionRecord): Promise<void> {
    if (!s?.sessionId) throw new Error("upsertSession: sessionId is required");
    await this.http.upsert(SESSIONS_TABLE, [sessionToRow(s)], "session_id");
  }

  async getSession(sessionId: SessionId): Promise<SessionRecord | null> {
    const rows = await this.http.select(SESSIONS_TABLE, { session_id: `eq.${sessionId}`, limit: 1 });
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async getSessionByShortId(shortId: ShortId): Promise<SessionRecord | null> {
    const want = (shortId ?? "").trim().toLowerCase();
    if (!want) return null;
    // ilike without wildcards = case-insensitive equality. Anything with pattern characters falls back to a scan.
    const rows = /^[a-z0-9-]+$/.test(want)
      ? await this.http.selectAll(SESSIONS_TABLE, { short_id: `ilike.${want}` })
      : await this.http.selectAll(SESSIONS_TABLE);
    const matches = rows.map(rowToSession).filter((s) => s.shortId?.toLowerCase() === want);
    if (!matches.length) return null;
    matches.sort((a, b) => time(b.startedAt) - time(a.startedAt));
    return matches[0];
  }

  /** All sessions, most recently started first. */
  async listSessions(): Promise<SessionRecord[]> {
    const rows = await this.http.selectAll(SESSIONS_TABLE);
    return rows.map(rowToSession).sort((a, b) => time(b.startedAt) - time(a.startedAt));
  }

  // ---------- transcripts ----------

  /**
   * Upload the transcript to `transcripts/<sessionId>.jsonl` and return `insforge:transcripts/<sessionId>.jsonl`.
   * The source is only read. A local cache copy is kept so the next load is instant.
   * If the session is registered, its `transcriptSnapshot` is set too.
   */
  async saveTranscriptSnapshot(sessionId: SessionId, localPath: string): Promise<string> {
    if (!SAFE_ID.test(sessionId)) throw new Error(`Invalid sessionId for a snapshot name: ${JSON.stringify(sessionId)}`);
    const src = path.resolve(localPath);
    if (!existsSync(src)) throw new Error(`Cannot snapshot session ${sessionId}: transcript not found at ${src}`);
    const data = await fs.readFile(src);
    const objectKey = `${sessionId}.jsonl`;
    await this.http.uploadObject(TRANSCRIPTS_BUCKET, objectKey, data);
    await this.writeCache(objectKey, data).catch(() => {});
    const key = snapshotKeyFor(sessionId);
    await this.http.update(SESSIONS_TABLE, { session_id: `eq.${sessionId}` }, { transcript_snapshot: key });
    return key;
  }

  /**
   * Upload a local snapshot unless InsForge already holds an object of the same size (for `seance migrate`).
   * Does not touch the session row. Returns the snapshot key.
   */
  async uploadSnapshotIfChanged(sessionId: SessionId, localPath: string): Promise<{ key: string; uploaded: boolean }> {
    if (!SAFE_ID.test(sessionId)) throw new Error(`Invalid sessionId for a snapshot name: ${JSON.stringify(sessionId)}`);
    const objectKey = `${sessionId}.jsonl`;
    const data = await fs.readFile(localPath);
    const remote = await this.http.objectSize(TRANSCRIPTS_BUCKET, objectKey);
    if (remote !== data.byteLength) await this.http.uploadObject(TRANSCRIPTS_BUCKET, objectKey, data);
    return { key: snapshotKeyFor(sessionId), uploaded: remote !== data.byteLength };
  }

  /** Size of the uploaded snapshot for a session, or null if there is none. */
  async remoteSnapshotSize(sessionId: SessionId): Promise<number | null> {
    return this.http.objectSize(TRANSCRIPTS_BUCKET, `${sessionId}.jsonl`);
  }

  /**
   * Returns a local path for a snapshot key. Accepts:
   *  - `insforge:<bucket>/<key>`: downloaded to <dataDir>/transcript-cache (cached copy reused when its size matches)
   *  - a local path (snapshots taken by the JSON registry): returned if it exists
   *  - a bare sessionId: treated as `insforge:transcripts/<sessionId>.jsonl`
   */
  async loadTranscriptSnapshot(key: string): Promise<string> {
    if (!key) throw new Error("loadTranscriptSnapshot: empty key");
    const remote = parseSnapshotKey(key);
    if (remote) return this.fetchToCache(remote.bucket, remote.objectKey);
    if (path.isAbsolute(key)) {
      if (existsSync(key)) return key;
      // A JSON-registry path whose file is gone (other machine, cleaned dir): the migrated copy may be in InsForge.
      const base = path.basename(key);
      if (SAFE_ID.test(base.replace(/\.jsonl$/, "")) && base.endsWith(".jsonl")) {
        try {
          return await this.fetchToCache(TRANSCRIPTS_BUCKET, base);
        } catch {
          /* fall through to the not-found error */
        }
      }
      throw new Error(`Transcript snapshot not found: ${key}. Was the session snapshotted? Try \`seance snapshot <shortId>\`.`);
    }
    const id = key.replace(/\.jsonl$/, "");
    if (SAFE_ID.test(id)) return this.fetchToCache(TRANSCRIPTS_BUCKET, `${id}.jsonl`);
    throw new Error(`loadTranscriptSnapshot: unrecognised key ${JSON.stringify(key)}`);
  }

  private cachePath(objectKey: string): string {
    return path.join(this.cacheDir, objectKey.split("/").join("__"));
  }

  private async fetchToCache(bucket: string, objectKey: string): Promise<string> {
    const dest = this.cachePath(objectKey);
    if (existsSync(dest)) {
      let remoteSize: number | null | undefined;
      try {
        remoteSize = await this.http.objectSize(bucket, objectKey);
      } catch {
        remoteSize = undefined; // listing failed: download below decides
      }
      if (remoteSize !== undefined && remoteSize !== null && remoteSize === statSync(dest).size) return dest;
      if (remoteSize === null) throw new Error(`Transcript snapshot not found in InsForge: ${bucket}/${objectKey}`);
    }
    let data: Uint8Array;
    try {
      data = await this.http.downloadObject(bucket, objectKey);
    } catch (err) {
      if (err instanceof InsForgeError && err.status === 404) throw new Error(`Transcript snapshot not found in InsForge: ${bucket}/${objectKey}`);
      throw err;
    }
    await this.writeCache(objectKey, data);
    return dest;
  }

  /** temp + rename, read-only, like the JSON registry's snapshots. */
  private async writeCache(objectKey: string, data: Uint8Array): Promise<string> {
    const dest = this.cachePath(objectKey);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tmp, data);
      await fs.chmod(tmp, 0o444);
      await fs.rename(tmp, dest);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return dest;
  }

  // ---------- questions ----------

  async createQuestion(q: QuestionRecord): Promise<void> {
    if (!q?.id) throw new Error("createQuestion: id is required");
    try {
      await this.http.insert(QUESTIONS_TABLE, [questionToRow(q)]);
    } catch (err) {
      if (isDuplicate(err)) throw new Error(`createQuestion: question ${q.id} already exists`);
      throw err;
    }
  }

  /** Insert or overwrite a question by id (used by `seance migrate`; idempotent). */
  async upsertQuestion(q: QuestionRecord): Promise<void> {
    if (!q?.id) throw new Error("upsertQuestion: id is required");
    await this.http.upsert(QUESTIONS_TABLE, [questionToRow(q)], "id");
  }

  async updateQuestion(id: string, patch: Partial<QuestionRecord>): Promise<void> {
    const row = questionToRow({ ...patch, id });
    delete row.id;
    if (!Object.keys(row).length) {
      if (!(await this.getQuestion(id))) throw new Error(`updateQuestion: unknown question id ${id}`);
      return;
    }
    const updated = await this.http.update(QUESTIONS_TABLE, { id: `eq.${id}` }, row);
    if (!updated.length) throw new Error(`updateQuestion: unknown question id ${id}`);
  }

  async getQuestion(id: string): Promise<QuestionRecord | null> {
    const rows = await this.http.select(QUESTIONS_TABLE, { id: `eq.${id}`, limit: 1 });
    return rows[0] ? rowToQuestion(rows[0]) : null;
  }

  async getQuestionByThread(threadId: string): Promise<QuestionRecord | null> {
    const rows = await this.http.selectAll(QUESTIONS_TABLE, { thread_id: `eq.${threadId}` });
    if (!rows.length) return null;
    const matches = rows.map(rowToQuestion).sort((a, b) => time(b.createdAt) - time(a.createdAt));
    return matches[0];
  }

  /** Questions newest first. */
  async listQuestions(limit?: number): Promise<QuestionRecord[]> {
    if (limit !== undefined && limit <= 0) return [];
    const rows =
      limit === undefined || limit > PAGE
        ? await this.http.selectAll(QUESTIONS_TABLE, { order: "created_at.desc" })
        : await this.http.select(QUESTIONS_TABLE, { order: "created_at.desc", limit });
    const all = rows.map(rowToQuestion).sort((a, b) => time(b.createdAt) - time(a.createdAt));
    return limit === undefined ? all : all.slice(0, limit);
  }
}
