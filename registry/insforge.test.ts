import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { InsForgeRegistry, InsForgeHttp, parseSnapshotKey, sessionToRow } from "./insforge.ts";
import { ensureSchema, SCHEMA_SQL } from "./insforge-setup.ts";
import { createRegistry } from "./index.ts";
import { loadConfig } from "../config/index.ts";
import { fakeInsForge, type FakeInsForge } from "./test-fixtures/insforge-fake.ts";
import type { QuestionRecord, SessionRecord } from "../shared/types.ts";

const BASE = "https://fake.insforge.test";
const KEY = "ik_test_key_do_not_leak_123";

let dir: string;
let fake: FakeInsForge;
let reg: InsForgeRegistry;

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: "7f3a1b2c-1111-2222-3333-444444444444",
  shortId: "7f3a1b2c",
  address: "s-7f3a1b2c@test.local",
  repoPath: "/tmp/repo",
  transcriptPath: "/tmp/t.jsonl",
  startedAt: "2026-10-18T10:00:00.000Z",
  ...over,
});

const question = (over: Partial<QuestionRecord> = {}): QuestionRecord => ({
  id: "q1",
  sessionShortId: "7f3a1b2c",
  from: "a@b.com",
  question: "why?",
  threadId: "thread-1",
  status: "received",
  createdAt: "2026-10-18T10:00:00.000Z",
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seance-insforge-"));
  fake = fakeInsForge({ base: BASE, apiKey: KEY });
  reg = new InsForgeRegistry({ url: `${BASE}/`, apiKey: KEY, dataDir: dir, fetch: fake.fetch });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("sessions", () => {
  it("round trips and stores snake_case columns", async () => {
    const s = session();
    await reg.upsertSession(s);
    expect(await reg.getSession(s.sessionId)).toEqual(s);
    expect(fake.tables.sessions[0]).toMatchObject({ session_id: s.sessionId, short_id: "7f3a1b2c", repo_path: "/tmp/repo", started_at: s.startedAt });
    expect(await reg.getSession("nope")).toBeNull();
  });

  it("sends the bearer key, on_conflict and merge-duplicates on upsert", async () => {
    await reg.upsertSession(session());
    const call = fake.calls.find((c) => c.method === "POST")!;
    expect(call.url.pathname).toBe("/api/database/records/sessions");
    expect(call.url.searchParams.get("on_conflict")).toBe("session_id");
    expect(call.headers.get("prefer")).toContain("resolution=merge-duplicates");
    expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("upsert merges and never wipes endedAt or transcriptSnapshot by omission", async () => {
    await reg.upsertSession(session({ endedAt: "2026-10-18T11:00:00.000Z", transcriptSnapshot: "insforge:transcripts/x.jsonl" }));
    await reg.upsertSession(session({ repoPath: "/tmp/other" }));
    const got = await reg.getSession(session().sessionId);
    expect(got).toMatchObject({ repoPath: "/tmp/other", endedAt: "2026-10-18T11:00:00.000Z", transcriptSnapshot: "insforge:transcripts/x.jsonl" });
    expect(sessionToRow({ sessionId: "a", endedAt: undefined })).toEqual({ session_id: "a" });
  });

  it("requires a sessionId", async () => {
    await expect(reg.upsertSession({} as SessionRecord)).rejects.toThrow(/sessionId is required/);
  });

  it("getSessionByShortId is case-insensitive and returns the newest", async () => {
    await reg.upsertSession(session({ sessionId: "7f3a1b2c-aaaa-0000-0000-000000000000", startedAt: "2026-10-18T09:00:00.000Z" }));
    await reg.upsertSession(session({ sessionId: "7f3a1b2c-bbbb-0000-0000-000000000000", startedAt: "2026-10-18T12:00:00.000Z" }));
    await reg.upsertSession(session({ sessionId: "deadbeef-0000-0000-0000-000000000000", shortId: "deadbeef" }));
    expect((await reg.getSessionByShortId("7F3A1B2C"))?.sessionId).toBe("7f3a1b2c-bbbb-0000-0000-000000000000");
    expect(await reg.getSessionByShortId("00000000")).toBeNull();
    expect(await reg.getSessionByShortId("  ")).toBeNull();
    expect(await reg.getSessionByShortId("7f3a%")).toBeNull(); // pattern chars never act as wildcards
  });

  it("listSessions is newest first", async () => {
    await reg.upsertSession(session({ sessionId: "a", startedAt: "2026-10-18T09:00:00.000Z" }));
    await reg.upsertSession(session({ sessionId: "b", startedAt: "2026-10-18T12:00:00.000Z" }));
    await reg.upsertSession(session({ sessionId: "c", startedAt: "2026-10-18T10:00:00.000Z" }));
    expect((await reg.listSessions()).map((s) => s.sessionId)).toEqual(["b", "c", "a"]);
  });

  it("pages past the 1000-row API limit", async () => {
    for (let i = 0; i < 1005; i++) fake.tables.sessions.push(sessionToRow(session({ sessionId: `s${i}`, startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() })));
    const all = await reg.listSessions();
    expect(all).toHaveLength(1005);
    expect(all[0].sessionId).toBe("s1004");
  });
});

describe("questions", () => {
  it("create, get, duplicate rejected", async () => {
    const q = question({ file: "src/retry.ts", line: 12 });
    await reg.createQuestion(q);
    expect(await reg.getQuestion("q1")).toEqual(q);
    expect(fake.tables.questions[0]).toMatchObject({ from_address: "a@b.com", thread_id: "thread-1", session_short_id: "7f3a1b2c", line: 12 });
    await expect(reg.createQuestion(q)).rejects.toThrow(/question q1 already exists/);
    expect(await reg.getQuestion("nope")).toBeNull();
  });

  it("updateQuestion shallow-merges, stores result as JSON, ignores undefined, throws on unknown id", async () => {
    await reg.createQuestion(question());
    const result = {
      answer: "0.25 double charges",
      quotes: [{ text: "charges=2", verified: true }],
      confidence: "high" as const,
      runId: "r1",
      runner: "local" as const,
      durationMs: 1200,
    };
    await reg.updateQuestion("q1", { status: "answered", result, answeredAt: "2026-10-18T10:01:00.000Z", blockedReason: undefined });
    const got = await reg.getQuestion("q1");
    expect(got).toMatchObject({ status: "answered", result, question: "why?", answeredAt: "2026-10-18T10:01:00.000Z" });
    expect(got).not.toHaveProperty("blockedReason");
    await reg.updateQuestion("q1", { id: "evil" } as Partial<QuestionRecord>); // id cannot be changed
    expect(await reg.getQuestion("q1")).not.toBeNull();
    await expect(reg.updateQuestion("missing", { status: "error" })).rejects.toThrow(/unknown question id missing/);
    await expect(reg.updateQuestion("missing", {})).rejects.toThrow(/unknown question id missing/);
  });

  it("getQuestionByThread returns the newest; listQuestions newest first with limit", async () => {
    await reg.createQuestion(question({ id: "q1", createdAt: "2026-10-18T10:00:00.000Z" }));
    await reg.createQuestion(question({ id: "q2", createdAt: "2026-10-18T12:00:00.000Z" }));
    await reg.createQuestion(question({ id: "q3", threadId: "other", createdAt: "2026-10-18T11:00:00.000Z" }));
    expect((await reg.getQuestionByThread("thread-1"))?.id).toBe("q2");
    expect(await reg.getQuestionByThread("none")).toBeNull();
    expect((await reg.listQuestions()).map((q) => q.id)).toEqual(["q2", "q3", "q1"]);
    expect((await reg.listQuestions(2)).map((q) => q.id)).toEqual(["q2", "q3"]);
    expect(await reg.listQuestions(0)).toEqual([]);
  });

  it("upsertQuestion is idempotent", async () => {
    await reg.upsertQuestion(question());
    await reg.upsertQuestion(question({ status: "answered" }));
    expect(fake.tables.questions).toHaveLength(1);
    expect((await reg.getQuestion("q1"))?.status).toBe("answered");
  });
});

describe("transcript snapshots", () => {
  const writeTranscript = (body = '{"type":"user","message":{"content":"hi"}}\n') => {
    const p = path.join(dir, "live.jsonl");
    fs.writeFileSync(p, body);
    return p;
  };

  it("uploads to transcripts/<sessionId>.jsonl, returns the insforge key, sets transcriptSnapshot, leaves the source alone", async () => {
    const s = session();
    await reg.upsertSession(s);
    const src = writeTranscript();
    const before = fs.readFileSync(src);
    const key = await reg.saveTranscriptSnapshot(s.sessionId, src);
    expect(key).toBe(`insforge:transcripts/${s.sessionId}.jsonl`);
    expect(Buffer.from(fake.objects.get(`transcripts/${s.sessionId}.jsonl`)!)).toEqual(before);
    expect((await reg.getSession(s.sessionId))?.transcriptSnapshot).toBe(key);
    expect(fs.readFileSync(src)).toEqual(before);
  });

  it("snapshotting an unregistered session still uploads and does not throw", async () => {
    const key = await reg.saveTranscriptSnapshot("unknown-session", writeTranscript());
    expect(key).toBe("insforge:transcripts/unknown-session.jsonl");
    expect(fake.tables.sessions).toEqual([]);
  });

  it("rejects a missing source and unsafe ids", async () => {
    await expect(reg.saveTranscriptSnapshot("abc", path.join(dir, "nope.jsonl"))).rejects.toThrow(/transcript not found/);
    await expect(reg.saveTranscriptSnapshot("../etc", writeTranscript())).rejects.toThrow(/Invalid sessionId/);
  });

  it("loads into <dataDir>/transcript-cache, reuses the cache when the size matches, re-downloads when it changed", async () => {
    const body = '{"type":"assistant"}\n';
    fake.objects.set("transcripts/sid-1.jsonl", new TextEncoder().encode(body));
    const p = await reg.loadTranscriptSnapshot("insforge:transcripts/sid-1.jsonl");
    expect(p).toBe(path.join(dir, "transcript-cache", "sid-1.jsonl"));
    expect(fs.readFileSync(p, "utf8")).toBe(body);

    const downloads = () => fake.calls.filter((c) => c.url.pathname.includes("/download-strategy/")).length;
    expect(downloads()).toBe(1);
    await reg.loadTranscriptSnapshot("insforge:transcripts/sid-1.jsonl");
    expect(downloads()).toBe(1); // cached

    fake.objects.set("transcripts/sid-1.jsonl", new TextEncoder().encode(body + body));
    const again = await reg.loadTranscriptSnapshot("insforge:transcripts/sid-1.jsonl");
    expect(downloads()).toBe(2);
    expect(fs.readFileSync(again, "utf8")).toBe(body + body);
  });

  it("a fresh save makes the next load a cache hit", async () => {
    const key = await reg.saveTranscriptSnapshot("sid-2", writeTranscript());
    const p = await reg.loadTranscriptSnapshot(key);
    expect(fs.existsSync(p)).toBe(true);
    expect(fake.calls.some((c) => c.url.pathname.includes("/download-strategy/"))).toBe(false);
  });

  it("accepts plain local paths (JSON-registry snapshots) and bare session ids", async () => {
    const local = writeTranscript();
    expect(await reg.loadTranscriptSnapshot(local)).toBe(local);
    fake.objects.set("transcripts/sid-3.jsonl", new TextEncoder().encode("x\n"));
    expect(fs.readFileSync(await reg.loadTranscriptSnapshot("sid-3"), "utf8")).toBe("x\n");
    // a JSON-registry path that is gone locally falls back to the migrated copy
    expect(fs.readFileSync(await reg.loadTranscriptSnapshot("/gone/.seance/transcripts/sid-3.jsonl"), "utf8")).toBe("x\n");
  });

  it("missing snapshots give clear errors", async () => {
    await expect(reg.loadTranscriptSnapshot("insforge:transcripts/none.jsonl")).rejects.toThrow(/not found in InsForge: transcripts\/none.jsonl/);
    await expect(reg.loadTranscriptSnapshot("/nope/x.jsonl")).rejects.toThrow(/Transcript snapshot not found/);
    await expect(reg.loadTranscriptSnapshot("")).rejects.toThrow(/empty key/);
    expect(parseSnapshotKey("insforge:transcripts/../x")).toBeNull();
  });

  it("works with presigned upload/download strategies without sending the key to S3", async () => {
    fake.mode = "presigned";
    const key = await reg.saveTranscriptSnapshot("sid-4", writeTranscript("abc\n"));
    expect(fake.calls.some((c) => c.url.pathname.endsWith("/confirm-upload"))).toBe(true);
    fs.rmSync(path.join(dir, "transcript-cache"), { recursive: true, force: true });
    const p = await reg.loadTranscriptSnapshot(key.replace("transcripts/", "transcripts/")); // same key
    expect(fs.readFileSync(p, "utf8")).toBe("abc\n");
    for (const c of fake.calls.filter((c) => c.url.host === "s3.fake.test")) expect(c.headers.get("authorization")).toBeNull();
  });
});

describe("http", () => {
  it("times out hung requests and never puts the key in errors", async () => {
    fake.hang = /records/;
    const slow = new InsForgeRegistry({ url: BASE, apiKey: KEY, dataDir: dir, fetch: fake.fetch, timeoutMs: 50 });
    const t0 = Date.now();
    const e = await slow.listSessions().catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/timed out after 50 ms/);
    expect((e as Error).message).not.toContain(KEY);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("surfaces API errors with status and message", async () => {
    const bad = new InsForgeRegistry({ url: BASE, apiKey: "wrong", dataDir: dir, fetch: fake.fetch });
    await expect(bad.listSessions()).rejects.toThrow(/HTTP 401/);
    fake.tables = {};
    await expect(reg.listSessions()).rejects.toThrow(/HTTP 404 TABLE_NOT_FOUND/);
  });

  it("requires url and key", () => {
    expect(() => new InsForgeHttp({ url: "", apiKey: "k" })).toThrow(/INSFORGE_URL/);
    expect(() => new InsForgeHttp({ url: BASE, apiKey: "" })).toThrow(/INSFORGE_API_KEY/);
  });
});

describe("ensureSchema", () => {
  it("creates tables and a private bucket once, then is a no-op", async () => {
    fake.tables = {};
    const r1 = await ensureSchema(new InsForgeHttp({ url: BASE, apiKey: KEY, fetch: fake.fetch }));
    expect(r1).toMatchObject({ migrated: true, bucket: "created", tables: ["sessions", "questions"] });
    expect(fake.buckets).toEqual([{ name: "transcripts", public: false }]);
    expect(fake.migrations[0].sql).toBe(SCHEMA_SQL);
    expect(SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS public.questions/);
    expect(SCHEMA_SQL).toMatch(/result jsonb/);
    const r2 = await ensureSchema(new InsForgeHttp({ url: BASE, apiKey: KEY, fetch: fake.fetch }));
    expect(r2).toMatchObject({ migrated: false, bucket: "ok" });
    expect(fake.migrations).toHaveLength(1);
  });

  it("makes a public transcripts bucket private", async () => {
    fake.buckets.push({ name: "transcripts", public: true });
    const r = await ensureSchema(new InsForgeHttp({ url: BASE, apiKey: KEY, fetch: fake.fetch }));
    expect(r.bucket).toBe("made-private");
    expect(fake.buckets[0].public).toBe(false);
  });
});

describe("createRegistry", () => {
  it("REGISTRY=insforge returns an InsForgeRegistry; missing settings are named", () => {
    const ok = createRegistry(loadConfig({ envFile: null, env: { SEANCE_DATA_DIR: dir, REGISTRY: "insforge", INSFORGE_URL: BASE, INSFORGE_API_KEY: KEY } }));
    expect(ok).toBeInstanceOf(InsForgeRegistry);
    expect(() => createRegistry(loadConfig({ envFile: null, env: { SEANCE_DATA_DIR: dir, REGISTRY: "insforge", INSFORGE_URL: BASE } }))).toThrow(
      /needs INSFORGE_API_KEY \(missing\)/,
    );
  });
});

// ---------- live round trip (opt-in): SEANCE_INSFORGE_LIVE=1 npx vitest run registry/insforge.test.ts ----------

const LIVE = process.env.SEANCE_INSFORGE_LIVE === "1";

describe.skipIf(!LIVE)("live InsForge round trip", () => {
  it("session, question and snapshot round-trip against the real project, then clean up", async () => {
    const cfg = loadConfig();
    if (!cfg.insforgeUrl || !cfg.insforgeApiKey) throw new Error("INSFORGE_URL / INSFORGE_API_KEY not set");
    const live = new InsForgeRegistry({ url: cfg.insforgeUrl, apiKey: cfg.insforgeApiKey, dataDir: dir });
    await ensureSchema(live.http);

    const sessionId = `livetest-${randomUUID()}`;
    const shortId = `zz${randomUUID().slice(0, 6)}`;
    const qid = `livetest-q-${randomUUID()}`;
    const threadId = `livetest-thread-${randomUUID()}`;
    const objectKey = `${sessionId}.jsonl`;
    const t0 = Date.now();
    try {
      const s = session({ sessionId, shortId, address: `s-${shortId}@test.local` });
      await live.upsertSession(s);
      await live.upsertSession({ ...s, endedAt: "2026-10-18T11:00:00.000Z" });
      await live.upsertSession(s); // must not wipe endedAt
      expect(await live.getSession(sessionId)).toEqual({ ...s, endedAt: "2026-10-18T11:00:00.000Z" });
      expect((await live.getSessionByShortId(shortId.toUpperCase()))?.sessionId).toBe(sessionId);
      expect((await live.listSessions()).some((x) => x.sessionId === sessionId)).toBe(true);

      const src = path.join(dir, "live.jsonl");
      const body = '{"type":"user","message":{"content":"pineapple"}}\n';
      fs.writeFileSync(src, body);
      const key = await live.saveTranscriptSnapshot(sessionId, src);
      expect(key).toBe(`insforge:transcripts/${objectKey}`);
      expect((await live.getSession(sessionId))?.transcriptSnapshot).toBe(key);
      fs.rmSync(path.join(dir, "transcript-cache"), { recursive: true, force: true });
      const local = await live.loadTranscriptSnapshot(key);
      expect(fs.readFileSync(local, "utf8")).toBe(body);
      expect(await live.loadTranscriptSnapshot(key)).toBe(local); // cache hit by size

      const q = question({ id: qid, sessionShortId: shortId, threadId, line: 7, file: "src/retry.ts" });
      await live.createQuestion(q);
      await expect(live.createQuestion(q)).rejects.toThrow(/already exists/);
      const result = { answer: "42", quotes: [{ text: "x", verified: true }], confidence: "high" as const, runId: "r", runner: "local" as const, durationMs: 1 };
      await live.updateQuestion(qid, { status: "answered", result });
      expect(await live.getQuestion(qid)).toEqual({ ...q, status: "answered", result });
      expect((await live.getQuestionByThread(threadId))?.id).toBe(qid);
      expect((await live.listQuestions(500)).some((x) => x.id === qid)).toBe(true);
      await expect(live.updateQuestion(`${qid}-missing`, { status: "error" })).rejects.toThrow(/unknown question id/);
      console.log(`[live] InsForge round trip OK in ${Date.now() - t0} ms`);
    } finally {
      await live.http.delete("questions", { id: `eq.${qid}` }).catch(() => {});
      await live.http.delete("sessions", { session_id: `eq.${sessionId}` }).catch(() => {});
      await live.http.deleteObject("transcripts", objectKey).catch(() => {});
    }
    expect(await live.getSession(sessionId)).toBeNull();
    expect(await live.getQuestion(qid)).toBeNull();
    expect(await live.remoteSnapshotSize(sessionId)).toBeNull();
  }, 60_000);
});
