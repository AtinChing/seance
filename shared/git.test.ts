import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { blameRange, lastCommitForSession, repoRoot, sessionAddressForCommit, whoisLine } from "./git.ts";

let repo: string;
const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();

beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seance-git-")));
  g("init", "-q");
  g("config", "user.email", "human@example.com");
  g("config", "user.name", "Human");
  fs.writeFileSync(path.join(repo, "a.ts"), "one\ntwo\n");
  g("add", ".");
  g("commit", "-qm", "human commit");
  fs.writeFileSync(path.join(repo, "a.ts"), "one\nTWO\nthree\n");
  g("add", ".");
  g("commit", "-qm", "agent commit\n\nAgent-Session: s-7f3a1b2c@x.example\nCo-Authored-By: Claude session 7f3a1b2c <s-7f3a1b2c@x.example>");
});

describe("git helpers", () => {
  it("blames a range", async () => {
    const b = await blameRange(repo, "a.ts", 1, 3);
    expect(b.map((x) => x.line)).toEqual([1, 2, 3]);
    expect(b[0].sha).not.toBe(b[1].sha);
  });
  it("reads trailers and resolves whois", async () => {
    const w = await whoisLine(repo, "a.ts", 2);
    expect(w.address).toBe("s-7f3a1b2c@x.example");
    expect(w.shortId).toBe("7f3a1b2c");
    expect(w.subject).toBe("agent commit");
    const human = await whoisLine(repo, "a.ts", 1);
    expect(human.address).toBeNull();
    expect(await sessionAddressForCommit(repo, human.sha)).toBeNull();
  });
  it("finds the session's last commit", async () => {
    expect(await lastCommitForSession(repo, "7f3a1b2c")).toBe(g("rev-parse", "HEAD"));
    expect(await lastCommitForSession(repo, "deadbeef")).toBeNull();
  });
  it("finds the repo root", async () => {
    expect(await repoRoot(repo)).toBe(repo);
    expect(await repoRoot(os.tmpdir())).toBeNull();
  });
});
