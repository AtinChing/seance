import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JsonRegistry, createRegistry } from "./index.ts";
import { loadConfig } from "../config/index.ts";
import type { QuestionRecord, SessionRecord } from "../shared/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SEANCE_ROOT = path.resolve(here, "..");

let dir: string;
let reg: JsonRegistry;

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seance-reg-"));
  reg = new JsonRegistry(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  // snapshots are 0444; rm -rf still works since the dir is writable
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("sessions", () => {
  it("empty or missing file is an empty registry", async () => {
    expect(await reg.listSessions()).toEqual([]);
    fs.writeFileSync(path.join(dir, "registry.json"), "  \n");
    expect(await reg.listSessions()).toEqual([]);
    expect(await reg.getSessionByShortId("7f3a1b2c")).toBeNull();
  });

  it("round trips and writes the documented file format", async () => {
    const s = session();
    await reg.upsertSession(s);
    expect(await reg.getSession(s.sessionId)).toEqual(s);
    expect(await reg.listSessions()).toEqual([s]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
    expect(onDisk).toEqual({ version: 1, sessions: { [s.sessionId]: s }, questions: {} });
    // a second instance (another process) sees it: nothing is cached
    expect(await new JsonRegistry(dir).getSession(s.sessionId)).toEqual(s);
    expect(fs.existsSync(path.join(dir, "registry.lock"))).toBe(false);
  });

  it("upsert merges and never wipes fields that were not provided", async () => {
    await reg.upsertSession(session({ endedAt: "2026-10-18T11:00:00.000Z", transcriptSnapshot: "/snap.jsonl" }));
    // resumed session: SessionStart again with a fresh record lacking endedAt/snapshot
    await reg.upsertSession(session({ transcriptPath: "/tmp/t2.jsonl", endedAt: undefined }));
    const got = await reg.getSession(session().sessionId);
    expect(got).toMatchObject({ transcriptPath: "/tmp/t2.jsonl", endedAt: "2026-10-18T11:00:00.000Z", transcriptSnapshot: "/snap.jsonl" });
    // explicitly given values do overwrite
    await reg.upsertSession(session({ endedAt: "2026-10-18T12:00:00.000Z" }));
    expect((await reg.getSession(session().sessionId))?.endedAt).toBe("2026-10-18T12:00:00.000Z");
  });

  it("getSessionByShortId is case-insensitive and picks the most recent on collision", async () => {
    await reg.upsertSession(session({ sessionId: "aaaa-old", shortId: "ABCDEF12", startedAt: "2026-10-17T10:00:00.000Z" }));
    await reg.upsertSession(session({ sessionId: "aaaa-new", shortId: "abcdef12", startedAt: "2026-10-18T10:00:00.000Z" }));
    await reg.upsertSession(session({ sessionId: "other", shortId: "99999999" }));
    expect((await reg.getSessionByShortId("AbCdEf12"))?.sessionId).toBe("aaaa-new");
    expect((await reg.getSessionByShortId("99999999"))?.sessionId).toBe("other");
    expect(await reg.getSessionByShortId("deadbeef")).toBeNull();
    expect((await reg.listSessions()).map((s) => s.sessionId)[0]).toBe("aaaa-new");
  });
});

describe("transcript snapshots", () => {
  it("copies byte-identically, read-only, leaves the source untouched, and updates the session", async () => {
    const src = path.join(dir, "live.jsonl");
    const content = Buffer.from('{"type":"user","message":{"content":"pineapple ✨"}}\n');
    fs.writeFileSync(src, content);
    const srcStatBefore = fs.statSync(src);
    const s = session();
    await reg.upsertSession(s);

    const key = await reg.saveTranscriptSnapshot(s.sessionId, src);
    expect(key).toBe(path.join(dir, "transcripts", `${s.sessionId}.jsonl`));
    expect(path.isAbsolute(key)).toBe(true);
    expect(fs.readFileSync(key).equals(content)).toBe(true);
    expect(fs.statSync(key).mode & 0o777).toBe(0o444);

    const srcStatAfter = fs.statSync(src);
    expect(fs.readFileSync(src).equals(content)).toBe(true);
    expect(srcStatAfter.mode).toBe(srcStatBefore.mode);
    expect(srcStatAfter.mtimeMs).toBe(srcStatBefore.mtimeMs);

    expect((await reg.getSession(s.sessionId))?.transcriptSnapshot).toBe(key);
    expect(await reg.loadTranscriptSnapshot(key)).toBe(key);
    expect(await reg.loadTranscriptSnapshot(s.sessionId)).toBe(key);
  });

  it("re-snapshotting overwrites the read-only copy", async () => {
    const src = path.join(dir, "live.jsonl");
    fs.writeFileSync(src, "one\n");
    const key = await reg.saveTranscriptSnapshot("sess-1", src);
    fs.appendFileSync(src, "two\n");
    expect(await reg.saveTranscriptSnapshot("sess-1", src)).toBe(key);
    expect(fs.readFileSync(key, "utf8")).toBe("one\ntwo\n");
    expect(fs.statSync(key).mode & 0o777).toBe(0o444);
    expect(fs.readdirSync(path.join(dir, "transcripts"))).toEqual(["sess-1.jsonl"]);
  });

  it("errors clearly", async () => {
    await expect(reg.loadTranscriptSnapshot(path.join(dir, "nope.jsonl"))).rejects.toThrow(/Transcript snapshot not found/);
    await expect(reg.loadTranscriptSnapshot("unknown-session")).rejects.toThrow(/not found/);
    await expect(reg.saveTranscriptSnapshot("s", path.join(dir, "missing.jsonl"))).rejects.toThrow(/transcript not found/);
    await expect(reg.saveTranscriptSnapshot("../evil", path.join(dir, "x"))).rejects.toThrow(/Invalid sessionId/);
  });
});

describe("questions", () => {
  it("create, update (shallow merge), get by thread, list newest first", async () => {
    await reg.createQuestion(question());
    await reg.createQuestion(question({ id: "q2", threadId: "thread-1", createdAt: "2026-10-18T12:00:00.000Z" }));
    await reg.createQuestion(question({ id: "q3", threadId: "thread-2", createdAt: "2026-10-18T11:00:00.000Z" }));

    await reg.updateQuestion("q1", { status: "answered", answeredAt: "2026-10-18T10:01:00.000Z" });
    expect(await reg.getQuestion("q1")).toEqual({ ...question(), status: "answered", answeredAt: "2026-10-18T10:01:00.000Z" });

    expect((await reg.getQuestionByThread("thread-1"))?.id).toBe("q2");
    expect((await reg.getQuestionByThread("thread-2"))?.id).toBe("q3");
    expect(await reg.getQuestionByThread("nope")).toBeNull();

    expect((await reg.listQuestions()).map((q) => q.id)).toEqual(["q2", "q3", "q1"]);
    expect((await reg.listQuestions(2)).map((q) => q.id)).toEqual(["q2", "q3"]);
  });

  it("throws on unknown id and duplicate create", async () => {
    await expect(reg.updateQuestion("ghost", { status: "error" })).rejects.toThrow(/unknown question id ghost/);
    await reg.createQuestion(question());
    await expect(reg.createQuestion(question())).rejects.toThrow(/already exists/);
  });
});

describe("corruption and locking", () => {
  it("moves a corrupt file aside and treats the registry as empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(path.join(dir, "registry.json"), "{ not json");
    expect(await reg.listSessions()).toEqual([]);
    const aside = fs.readdirSync(dir).filter((f) => f.startsWith("registry.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), "utf8")).toBe("{ not json");
    expect(warn).toHaveBeenCalled();
    // and it keeps working
    await reg.upsertSession(session());
    expect(await reg.listSessions()).toHaveLength(1);
  });

  it("recovers on a write path too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(path.join(dir, "registry.json"), "[1,2,3]");
    await reg.createQuestion(question());
    expect(await reg.listQuestions()).toHaveLength(1);
    expect(fs.readdirSync(dir).some((f) => f.startsWith("registry.json.corrupt-"))).toBe(true);
  });

  it("takes over a stale lock", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const lock = path.join(dir, "registry.lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), "dead-process");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const t0 = Date.now();
    await reg.upsertSession(session());
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await reg.listSessions()).toHaveLength(1);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("registry.lock"))).toEqual([]);
  });

  it("waits for, then gives up on, a fresh lock held by someone else", async () => {
    const lock = path.join(dir, "registry.lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), "live-process");
    const quick = new JsonRegistry(dir, { timeoutMs: 300 });
    await expect(quick.upsertSession(session())).rejects.toThrow(/could not acquire lock/);
    expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe("live-process");
    // once released, writes proceed
    const pending = new JsonRegistry(dir).upsertSession(session());
    setTimeout(() => fs.rmSync(lock, { recursive: true, force: true }), 150);
    await pending;
    expect(await reg.listSessions()).toHaveLength(1);
  });

  it("loses nothing when 8 processes upsert at the same time", async () => {
    const workers = 8;
    const perWorker = 10;
    const script = path.join(here, "test-fixtures", "upsert-worker.ts");
    const runs = Array.from({ length: workers }, (_, w) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", script, dir, String(w), String(perWorker)], {
          cwd: SEANCE_ROOT,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let err = "";
        child.stderr.on("data", (d) => (err += d));
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${w} exited ${code}: ${err}`))));
      }),
    );
    await Promise.all(runs);
    const all = await reg.listSessions();
    expect(all).toHaveLength(workers * perWorker);
    const ids = new Set(all.map((s) => s.sessionId));
    for (let w = 0; w < workers; w++) for (let i = 0; i < perWorker; i++) expect(ids.has(`w${w}-s${i}-0000-0000-000000000000`)).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp") || f.startsWith("registry.lock"))).toEqual([]);
  }, 60_000);
});

describe("createRegistry", () => {
  it("uses config.dataDir for json; insforge without credentials is a clear error (M6)", async () => {
    const json = createRegistry(loadConfig({ envFile: null, env: { SEANCE_DATA_DIR: dir, REGISTRY: "json" } }));
    expect(json).toBeInstanceOf(JsonRegistry);
    expect((json as JsonRegistry).dataDir).toBe(dir);
    expect(() => createRegistry(loadConfig({ envFile: null, env: { SEANCE_DATA_DIR: dir, REGISTRY: "insforge" } }))).toThrow(
      /INSFORGE_URL and INSFORGE_API_KEY/,
    );
  });
});
