import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type SeanceConfig } from "../config/index.ts";
import type { SessionRecord } from "../shared/types.ts";
import { GhostError } from "./errors.ts";
import { encodeCwd, ghostArgs, LocalRunner } from "./local.ts";
import { buildGhostPrompt } from "./prompt.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PINEAPPLE = path.join(here, "..", "shared", "fixtures", "transcript-pineapple.jsonl");
const SESSION_ID = "c582ae8f-939d-42fe-94dd-cec74d30d65d";
const FAKE_KEY = "test-ghosts-key-not-real-0123456789";

let root: string;
let repo: string;
let sessionCommit: string;
let headCommit: string;
let config: SeanceConfig;
let tmpRoot: string;
const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seance-local-")));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  g("init", "-q");
  g("config", "user.email", "human@example.com");
  g("config", "user.name", "Human");
  fs.writeFileSync(path.join(repo, "retry.py"), "RETRY_BASE_DELAY = 0.37\n");
  g("add", ".");
  g("commit", "-qm", "agent commit\n\nAgent-Session: s-c582ae8f@x.example");
  sessionCommit = g("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "retry.py"), "RETRY_BASE_DELAY = 0.25\n");
  g("commit", "-qam", "later human commit");
  headCommit = g("rev-parse", "HEAD");
  tmpRoot = path.join(root, "runs");
  config = loadConfig({ envFile: null, env: { GHOSTS_API_KEY: FAKE_KEY, SEANCE_DATA_DIR: path.join(root, "data") } });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const session = (repoPath = repo): SessionRecord => ({
  sessionId: SESSION_ID,
  shortId: "c582ae8f",
  address: "s-c582ae8f@x.example",
  repoPath,
  transcriptPath: PINEAPPLE,
  startedAt: "2026-10-18T08:08:09Z",
});

const input = (repoPath?: string) => ({
  session: session(repoPath),
  transcriptLocalPath: PINEAPPLE,
  question: "What word did I ask you to remember?",
  from: "judge@example.com",
  file: "retry.py",
  line: 1,
});

type Mode = "ok" | "is_error" | "exit1" | "garbage" | "hang" | "leak";

/** A fake `claude` that records what it saw into a file baked into the script. */
function fakeClaude(mode: Mode): { bin: string; record: string } {
  const dir = fs.mkdtempSync(path.join(root, "fake-"));
  const record = path.join(dir, "record.json");
  const bin = path.join(dir, "claude");
  const result = JSON.stringify({
    answer: "You asked me to remember pineapple.",
    quotes: ["Remember the word pineapple.", "the secret code word is mango"],
    confidence: "high",
  });
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const mode = ${JSON.stringify(mode)};
const cwd = process.cwd();
const enc = fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-");
const jsonl = path.join(process.env.CLAUDE_CONFIG_DIR || "", "projects", enc, ${JSON.stringify(SESSION_ID)} + ".jsonl");
let head = null; try { head = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(); } catch {}
const rec = { argv: process.argv.slice(2), cwd, env: { ...process.env }, jsonl, jsonlExists: fs.existsSync(jsonl),
  jsonlContent: fs.existsSync(jsonl) ? fs.readFileSync(jsonl, "utf8") : null, head, pid: process.pid,
  configDir: process.env.CLAUDE_CONFIG_DIR };
if (mode === "hang") {
  const kid = cp.spawn("sleep", ["60"], { stdio: "ignore" });
  rec.grandchild = kid.pid;
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(rec));
  setTimeout(() => {}, 60000);
  return;
}
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(rec));
if (mode === "exit1") { process.stderr.write("boom: key " + process.env.ANTHROPIC_API_KEY + "\\n"); process.exit(1); }
if (mode === "garbage") { process.stdout.write("this is not json"); process.exit(0); }
if (mode === "is_error") { process.stdout.write(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "ran out of turns", session_id: "new-id" })); process.exit(0); }
const text = mode === "leak" ? ${JSON.stringify(result)} : "Here is my answer:\\n\`\`\`json\\n" + ${JSON.stringify(result)} + "\\n\`\`\`";
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: "forked-session-id", total_cost_usd: 0.123 }));
`,
  );
  fs.chmodSync(bin, 0o755);
  return { bin, record };
}

const readRecord = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const worktrees = () => g("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
const quiet = () => {};

describe("encodeCwd", () => {
  it("replaces every non-alphanumeric char with a dash", () => {
    expect(encodeCwd("/Users/a_b/my.repo-x")).toBe("-Users-a-b-my-repo-x");
  });
  it("encodes the realpath (macOS /tmp -> /private/tmp)", () => {
    const real = fs.realpathSync(os.tmpdir());
    expect(encodeCwd(os.tmpdir())).toBe(real.replace(/[^a-zA-Z0-9]/g, "-"));
    if (process.platform === "darwin" && fs.existsSync("/tmp")) expect(encodeCwd("/tmp")).toBe("-private-tmp");
  });
  const projects = path.join(os.homedir(), ".claude", "projects");
  const seanceRoot = path.resolve(here, "..");
  it.skipIf(!fs.existsSync(projects))("matches a folder Claude Code made for this checkout on this machine", () => {
    const names = fs.readdirSync(projects);
    // Any Claude Code session run in this checkout leaves a folder named with this encoding.
    if (names.some((n) => n.startsWith("-") && n.includes("seance"))) expect(names).toContain(encodeCwd(seanceRoot));
  });
});

describe("LocalRunner", () => {
  it("runs the fork with the exact argv, worktree cwd, minimal env and copied transcript, then cleans up", async () => {
    const { bin, record } = fakeClaude("ok");
    const logs: string[] = [];
    const runner = new LocalRunner({ config, claudeBin: bin, tmpRoot, log: (m) => logs.push(m) });
    const res = await runner.run(input());
    const rec = readRecord(record);

    const prompt = buildGhostPrompt({ from: "judge@example.com", file: "retry.py", line: 1, question: "What word did I ask you to remember?" });
    expect(rec.argv).toEqual(ghostArgs(prompt, SESSION_ID, "sonnet"));
    expect(rec.argv).toEqual([
      "-p", prompt, "--resume", SESSION_ID, "--fork-session", "--setting-sources", "user", "--model", "sonnet",
      "--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Bash,Edit,MultiEdit,Write,WebFetch,WebSearch",
      "--max-turns", "10", "--output-format", "json",
    ]);

    // cwd is the worktree under tmpRoot/<runId>/repo, at the session's last commit (not HEAD)
    expect(rec.cwd).toBe(path.join(fs.realpathSync(tmpRoot), res.runId, "repo"));
    expect(rec.head).toBe(sessionCommit);
    expect(rec.head).not.toBe(headCommit);

    // env has only the allowed keys (macOS CoreFoundation adds __CF_USER_TEXT_ENCODING inside any node child
    // process at startup; /usr/bin/env spawned with the same env object does not show it)
    expect(Object.keys(rec.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "HOME", "PATH", "SEANCE_GHOST"]);
    expect(rec.env.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    expect(rec.env.SEANCE_GHOST).toBe("1");
    expect(rec.env.CLAUDE_CONFIG_DIR).toBe(path.join(config.dataDir, "ghost-home", res.runId));
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    // transcript copied byte for byte to <ghost-home>/projects/<encoded worktree>/<id>.jsonl
    expect(rec.jsonl).toBe(path.join(rec.configDir, "projects", encodeCwd(rec.cwd), `${SESSION_ID}.jsonl`));
    expect(rec.jsonlExists).toBe(true);
    expect(rec.jsonlContent).toBe(fs.readFileSync(PINEAPPLE, "utf8"));

    // parsed and verified against the original snapshot
    expect(res).toMatchObject({
      answer: "You asked me to remember pineapple.",
      confidence: "high",
      runner: "local",
      costUsd: 0.123,
      quotes: [
        { text: "Remember the word pineapple.", verified: true },
        { text: "the secret code word is mango", verified: false },
      ],
    });
    expect(res.runId).toMatch(/^[0-9a-f]{12}$/);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);

    // cleanup
    expect(fs.existsSync(rec.configDir)).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, res.runId))).toBe(false);
    expect(worktrees()).toBe(1);
    expect(logs.join("\n")).not.toContain(FAKE_KEY);
  });

  it("uses SEANCE_GHOST_MODEL when set", async () => {
    const { bin, record } = fakeClaude("ok");
    const cfg = loadConfig({ envFile: null, env: { ...config.raw, SEANCE_GHOST_MODEL: "opus" } });
    await new LocalRunner({ config: cfg, claudeBin: bin, tmpRoot, log: quiet }).run(input());
    const argv: string[] = readRecord(record).argv;
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
  });

  it("falls back to HEAD when the session has no commit, and to repoPath when there is no git repo", async () => {
    const other = { ...input(), session: { ...session(), shortId: "deadbeef" } };
    const a = fakeClaude("ok");
    await new LocalRunner({ config, claudeBin: a.bin, tmpRoot, log: quiet }).run(other);
    expect(readRecord(a.record).head).toBe(headCommit);

    const plain = fs.mkdtempSync(path.join(root, "plain-"));
    const b = fakeClaude("ok");
    const logs: string[] = [];
    await new LocalRunner({ config, claudeBin: b.bin, tmpRoot, log: (m) => logs.push(m) }).run(input(plain));
    const rec = readRecord(b.record);
    expect(rec.cwd).toBe(fs.realpathSync(plain));
    expect(rec.jsonlExists).toBe(true);
    expect(logs.some((l) => l.includes("using repoPath as cwd"))).toBe(true);
    expect(fs.existsSync(plain)).toBe(true); // the repo itself is never deleted
  });

  it("throws GhostError when claude reports is_error, and still cleans up", async () => {
    const { bin, record } = fakeClaude("is_error");
    const run = new LocalRunner({ config, claudeBin: bin, tmpRoot, log: quiet }).run(input());
    await expect(run).rejects.toBeInstanceOf(GhostError);
    await expect(run).rejects.toThrow(/error_max_turns/);
    expect(fs.existsSync(readRecord(record).configDir)).toBe(false);
    expect(worktrees()).toBe(1);
  });

  it("throws GhostError on non-zero exit without leaking the key", async () => {
    const { bin } = fakeClaude("exit1");
    const err = await new LocalRunner({ config, claudeBin: bin, tmpRoot, log: quiet }).run(input()).catch((e) => e);
    expect(err).toBeInstanceOf(GhostError);
    expect(err.message).toMatch(/exited with 1/);
    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.message).toContain("[redacted]");
  });

  it("throws GhostError on unparseable stdout", async () => {
    const { bin } = fakeClaude("garbage");
    await expect(new LocalRunner({ config, claudeBin: bin, tmpRoot, log: quiet }).run(input())).rejects.toThrow(/unparseable/);
  });

  it("throws GhostError when the binary is missing", async () => {
    await expect(
      new LocalRunner({ config, claudeBin: path.join(root, "no-such-claude"), tmpRoot, log: quiet }).run(input()),
    ).rejects.toBeInstanceOf(GhostError);
    expect(worktrees()).toBe(1);
  });

  it("throws GhostError without a ghosts key", async () => {
    const cfg = loadConfig({ envFile: null, env: { SEANCE_DATA_DIR: config.dataDir } });
    await expect(new LocalRunner({ config: cfg, claudeBin: "x", tmpRoot, log: quiet }).run(input())).rejects.toThrow(/GHOSTS_API_KEY/);
  });

  it("kills the whole process group on timeout", async () => {
    const { bin, record } = fakeClaude("hang");
    const started = Date.now();
    const err = await new LocalRunner({ config, claudeBin: bin, tmpRoot, timeoutMs: 1500, log: quiet }).run(input()).catch((e) => e);
    expect(err).toBeInstanceOf(GhostError);
    expect(err.message).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(10_000);
    const rec = readRecord(record);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(rec.pid)).toBe(false);
    expect(alive(rec.grandchild)).toBe(false);
    expect(fs.existsSync(rec.configDir)).toBe(false);
    expect(worktrees()).toBe(1);
  });

  it("keeps the ghost home and worktree when debug is on", async () => {
    const { bin, record } = fakeClaude("ok");
    const cfg = { ...config, debug: true };
    const res = await new LocalRunner({ config: cfg, claudeBin: bin, tmpRoot, log: quiet }).run(input());
    const rec = readRecord(record);
    expect(fs.existsSync(rec.jsonl)).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, res.runId, "repo"))).toBe(true);
    g("worktree", "remove", "--force", path.join(tmpRoot, res.runId, "repo"));
    fs.rmSync(rec.configDir, { recursive: true, force: true });
  });
});
