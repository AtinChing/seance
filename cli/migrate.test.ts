import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config/index.ts";
import { JsonRegistry } from "../registry/json.ts";
import { InsForgeRegistry } from "../registry/insforge.ts";
import { fakeInsForge, type FakeInsForge } from "../registry/test-fixtures/insforge-fake.ts";
import type { QuestionRecord, SessionRecord } from "../shared/types.ts";
import { migrateCommand } from "./migrate.ts";
import { memoryIo } from "./io.ts";
import { runCli } from "./main.ts";

const BASE = "https://fake.insforge.test";
const KEY = "ik_test_key";

let dir: string;
let fake: FakeInsForge;

const session = (id: string, over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: `${id}-1111-2222-3333-444444444444`,
  shortId: id,
  address: `s-${id}@test.local`,
  repoPath: "/tmp/repo",
  transcriptPath: "/tmp/t.jsonl",
  startedAt: "2026-10-18T10:00:00.000Z",
  ...over,
});

const question = (id: string, over: Partial<QuestionRecord> = {}): QuestionRecord => ({
  id,
  sessionShortId: "aaaaaaaa",
  from: "a@b.com",
  question: "why?",
  threadId: `t-${id}`,
  status: "answered",
  createdAt: "2026-10-18T10:00:00.000Z",
  result: { answer: "because", quotes: [], confidence: "high", runId: "r", runner: "local", durationMs: 5 },
  ...over,
});

const config = () => loadConfig({ envFile: null, env: { SEANCE_DATA_DIR: dir, INSFORGE_URL: BASE, INSFORGE_API_KEY: KEY } });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seance-migrate-"));
  fake = fakeInsForge({ base: BASE, apiKey: KEY });
  fake.tables = {}; // migrate sets the schema up itself
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function seedJson() {
  const json = new JsonRegistry(dir);
  const a = session("aaaaaaaa", { endedAt: "2026-10-18T11:00:00.000Z" });
  const b = session("bbbbbbbb", { startedAt: "2026-10-18T12:00:00.000Z" });
  const c = session("cccccccc", { transcriptSnapshot: "/gone/transcripts/cccccccc.jsonl" });
  for (const s of [a, b, c]) await json.upsertSession(s);
  const live = path.join(dir, "live.jsonl");
  fs.writeFileSync(live, '{"type":"user"}\n');
  const snap = await json.saveTranscriptSnapshot(a.sessionId, live);
  await json.createQuestion(question("q1"));
  await json.createQuestion(question("q2", { status: "blocked", blockedReason: "sender", result: undefined }));
  return { a, b, c, snap };
}

describe("seance migrate", () => {
  it("copies sessions, questions and snapshots, and is idempotent", async () => {
    const { a, b, c, snap } = await seedJson();
    const io = memoryIo();
    expect(await migrateCommand([], { config: config(), io, fetch: fake.fetch })).toBe(0);
    const out = io.text();
    expect(out).toMatch(/sessions: 3, questions: 2, snapshots: 1 uploaded, 0 already there, 1 missing \(s-cccccccc\)/);
    expect(fake.buckets).toEqual([{ name: "transcripts", public: false }]);

    const target = new InsForgeRegistry({ url: BASE, apiKey: KEY, dataDir: path.join(dir, "other"), fetch: fake.fetch });
    expect(await target.getSession(a.sessionId)).toEqual({ ...a, transcriptSnapshot: `insforge:transcripts/${a.sessionId}.jsonl` });
    expect(await target.getSession(b.sessionId)).toEqual(b);
    expect((await target.getSession(c.sessionId))?.transcriptSnapshot).toBe("/gone/transcripts/cccccccc.jsonl");
    expect(await target.getQuestion("q1")).toEqual(question("q1"));
    expect(await target.getQuestion("q2")).toEqual(question("q2", { status: "blocked", blockedReason: "sender", result: undefined }));
    const loaded = await target.loadTranscriptSnapshot(`insforge:transcripts/${a.sessionId}.jsonl`);
    expect(fs.readFileSync(loaded)).toEqual(fs.readFileSync(snap));

    // second run: nothing duplicated, nothing re-uploaded
    const uploads = () => fake.calls.filter((c) => c.url.pathname.endsWith("/upload-strategy")).length;
    const before = uploads();
    const io2 = memoryIo();
    expect(await migrateCommand([], { config: config(), io: io2, fetch: fake.fetch })).toBe(0);
    expect(io2.text()).toMatch(/sessions: 3, questions: 2, snapshots: 0 uploaded, 1 already there/);
    expect(uploads()).toBe(before);
    expect(fake.tables.sessions).toHaveLength(3);
    expect(fake.tables.questions).toHaveLength(2);
    expect(fake.migrations).toHaveLength(1);
  });

  it("names missing InsForge settings without touching the network", async () => {
    const io = memoryIo();
    const code = await runCli(["migrate"], { io, config: loadConfig({ envFile: null, env: { SEANCE_DATA_DIR: dir } }) });
    expect(code).toBe(1);
    expect(io.text()).toMatch(/needs INSFORGE_URL and INSFORGE_API_KEY/);
  });

  it("rejects extra arguments and is listed in the usage", async () => {
    const io = memoryIo();
    expect(await migrateCommand(["x"], { config: config(), io })).toBe(1);
    const help = memoryIo();
    await runCli(["help"], { io: help });
    expect(help.text()).toMatch(/seance migrate/);
  });
});
