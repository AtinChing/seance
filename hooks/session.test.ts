import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { currentSessionFile } from "./common.ts";
import { sessionEnd } from "./session-end.ts";
import { sessionStart } from "./session-start.ts";
import { DOMAIN, FakeRegistry, hookCtx, SESSION_A, SESSION_B, TempRepo, testConfig, tmpDir } from "./test-helpers.ts";

let repo: TempRepo;
let reg: FakeRegistry;
let dataDir: string;
let transcript: string;

beforeEach(() => {
  repo = new TempRepo();
  reg = new FakeRegistry();
  dataDir = tmpDir("seance-data-");
  transcript = path.join(tmpDir("seance-tx-"), `${SESSION_A}.jsonl`);
  fs.writeFileSync(transcript, '{"type":"user","message":{"content":"hi"}}\n');
});

const ctx = () => hookCtx(repo.dir, reg, testConfig(dataDir));

describe("session-start", () => {
  it("registers the session and writes current-session", async () => {
    fs.mkdirSync(path.join(repo.dir, "sub"));
    const r = await sessionStart({ session_id: SESSION_A, transcript_path: transcript, cwd: path.join(repo.dir, "sub"), source: "startup" }, ctx());
    expect(r.code).toBe(0);
    const rec = await reg.getSessionByShortId("aaaaaaaa");
    expect(rec).toMatchObject({ sessionId: SESSION_A, shortId: "aaaaaaaa", address: `s-aaaaaaaa@${DOMAIN}`, repoPath: repo.dir, transcriptPath: transcript });
    expect(rec!.startedAt).toBeTruthy();
    expect(fs.readFileSync(currentSessionFile(repo.dir), "utf8").trim()).toBe(SESSION_A);
  });

  it("keeps the original startedAt on resume", async () => {
    await reg.upsertSession({ sessionId: SESSION_A, shortId: "aaaaaaaa", address: "x", repoPath: repo.dir, transcriptPath: transcript, startedAt: "2020-01-01T00:00:00.000Z", endedAt: "2020-01-01T01:00:00.000Z", transcriptSnapshot: "snap" });
    await sessionStart({ session_id: SESSION_A, transcript_path: transcript, cwd: repo.dir, source: "resume" }, ctx());
    const rec = await reg.getSessionByShortId("aaaaaaaa");
    expect(rec!.startedAt).toBe("2020-01-01T00:00:00.000Z");
    expect(rec!.endedAt).toBeUndefined();
    expect(rec!.transcriptSnapshot).toBe("snap");
  });

  it("uses cwd as the repo outside git", async () => {
    const dir = tmpDir("seance-nogit-");
    await sessionStart({ session_id: SESSION_A, transcript_path: transcript, cwd: dir }, ctx());
    expect((await reg.getSessionByShortId("aaaaaaaa"))!.repoPath).toBe(dir);
    expect(fs.existsSync(currentSessionFile(dir))).toBe(true);
  });
});

describe("session-end", () => {
  it("snapshots the transcript, sets endedAt and clears current-session", async () => {
    await sessionStart({ session_id: SESSION_A, transcript_path: transcript, cwd: repo.dir }, ctx());
    await sessionEnd({ session_id: SESSION_A, transcript_path: transcript, cwd: repo.dir, reason: "exit" }, ctx());
    const rec = await reg.getSessionByShortId("aaaaaaaa");
    expect(rec!.endedAt).toBeTruthy();
    expect(fs.readFileSync(rec!.transcriptSnapshot!, "utf8")).toBe(fs.readFileSync(transcript, "utf8"));
    expect(fs.existsSync(currentSessionFile(repo.dir))).toBe(false);
  });

  it("leaves current-session alone when another session owns it", async () => {
    await sessionStart({ session_id: SESSION_A, transcript_path: transcript, cwd: repo.dir }, ctx());
    await sessionStart({ session_id: SESSION_B, transcript_path: transcript, cwd: repo.dir }, ctx());
    await sessionEnd({ session_id: SESSION_A, transcript_path: transcript, cwd: repo.dir }, ctx());
    expect(fs.readFileSync(currentSessionFile(repo.dir), "utf8").trim()).toBe(SESSION_B);
  });

  it("creates a record if session-start never fired", async () => {
    await sessionEnd({ session_id: SESSION_A, transcript_path: transcript, cwd: repo.dir }, ctx());
    const rec = await reg.getSessionByShortId("aaaaaaaa");
    expect(rec).toMatchObject({ address: `s-aaaaaaaa@${DOMAIN}`, repoPath: repo.dir });
    expect(rec!.transcriptSnapshot).toBeTruthy();
  });
});
