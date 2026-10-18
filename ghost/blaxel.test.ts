import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type SeanceConfig } from "../config/index.ts";
import { TokenStore } from "../server/llm.ts";
import type { SessionRecord } from "../shared/types.ts";
import {
  BLAXEL_ALLOWED_TOOLS,
  BlaxelRunner,
  blaxelCredentialProblem,
  SANDBOX_CLAUDE_DIR,
  SANDBOX_REPO,
  shellJoin,
  type BlaxelCreateConfig,
  type BlaxelProcessRequest,
  type BlaxelProcessResult,
  type BlaxelSandbox,
  type BlaxelSdk,
} from "./blaxel.ts";
import { GhostError } from "./errors.ts";
import { createGhostRunner } from "./index.ts";
import { ghostArgs } from "./local.ts";
import { buildGhostPrompt } from "./prompt.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PINEAPPLE = path.join(here, "..", "shared", "fixtures", "transcript-pineapple.jsonl");
const SESSION_ID = "c582ae8f-939d-42fe-94dd-cec74d30d65d";
const FAKE_KEY = "sk-ant-test-ghosts-key-not-real-0123456789";
const FAKE_BL_KEY = "bl_test_api_key_not_real_987654321";
const PUBLIC = "https://seance-test.trycloudflare.com";

let root: string;
let repo: string;
let config: SeanceConfig;
const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seance-blaxel-")));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  g("init", "-q");
  g("config", "user.email", "human@example.com");
  g("config", "user.name", "Human");
  fs.writeFileSync(path.join(repo, "retry.py"), "RETRY_BASE_DELAY = 0.37\n");
  fs.writeFileSync(path.join(repo, "package.json"), '{"name":"t","scripts":{"test":"echo ok"}}\n');
  g("add", ".");
  g("commit", "-qm", "agent commit\n\nAgent-Session: s-c582ae8f@x.example");
  fs.writeFileSync(path.join(repo, "retry.py"), "RETRY_BASE_DELAY = 0.25\n");
  g("commit", "-qam", "later human commit");
  config = loadConfig({
    envFile: null,
    env: { GHOSTS_API_KEY: FAKE_KEY, PUBLIC_URL: PUBLIC, BL_WORKSPACE: "ws", BL_API_KEY: FAKE_BL_KEY, SEANCE_DATA_DIR: path.join(root, "data") },
  });
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
  question: "What word did I ask you to remember? Don't say 'banana'.",
  from: "judge@example.com",
  file: "retry.py",
  line: 1,
});

const GHOST_JSON = JSON.stringify({
  answer: "You asked me to remember pineapple.",
  quotes: ["Remember the word pineapple.", "the secret code word is mango"],
  confidence: "high",
});
const claudeStdout = (result = GHOST_JSON, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "forked", total_cost_usd: 0.21, ...extra });

type Script = (req: BlaxelProcessRequest) => BlaxelProcessResult | Promise<BlaxelProcessResult> | "hang";

interface Recorded {
  method: string;
  args: unknown[];
}

function mockSdk(opts: { ghost?: Script; tests?: Script; setup?: Script; refuseNetwork?: boolean; deleteFails?: boolean } = {}) {
  const calls: Recorded[] = [];
  const files = new Map<string, Buffer>();
  const execs: BlaxelProcessRequest[] = [];
  const creates: BlaxelCreateConfig[] = [];
  const killed: string[] = [];
  let deleted = 0;
  const pending = new Map<string, BlaxelProcessRequest>();
  const ok = (stdout = ""): BlaxelProcessResult => ({ status: "completed", exitCode: 0, stdout, stderr: "", logs: stdout });

  const sandbox: BlaxelSandbox = {
    fs: {
      async writeBinary(p, content) {
        calls.push({ method: "fs.writeBinary", args: [p, content] });
        files.set(p, Buffer.from(content));
        return { message: "ok" };
      },
    },
    process: {
      async exec(req) {
        calls.push({ method: "process.exec", args: [req] });
        execs.push(req);
        pending.set(req.name!, req);
        return { name: req.name, pid: "1", status: "running" };
      },
      async wait(id, o) {
        calls.push({ method: "process.wait", args: [id, o] });
        const req = pending.get(id)!;
        const script: Script | undefined =
          id === "seance-ghost" ? opts.ghost : id === "seance-npm-test" ? opts.tests : id === "seance-setup" ? opts.setup : undefined;
        const r = script ? await script(req) : ok(id === "seance-setup" ? "2.1.178 (Claude Code)" : "");
        if (r === "hang") return new Promise(() => {});
        return r;
      },
      async kill(id) {
        calls.push({ method: "process.kill", args: [id] });
        killed.push(id);
        return {};
      },
    },
    async delete() {
      calls.push({ method: "sandbox.delete", args: [] });
      deleted++;
      if (opts.deleteFails) throw new Error("boom");
      return {};
    },
  };
  const sdk: BlaxelSdk = {
    async createSandbox(cfg, o) {
      calls.push({ method: "createSandbox", args: [cfg, o] });
      creates.push(cfg);
      if (opts.refuseNetwork && cfg.network) throw new Error("proxy not available in this region");
      return sandbox;
    },
    async deleteSandbox(name) {
      calls.push({ method: "deleteSandbox", args: [name] });
      return {};
    },
  };
  return { sdk, calls, files, execs, creates, killed, get deleted() { return deleted; } };
}

/** Every SDK call argument flattened to text (Buffers as latin1), for leak checks. */
function dump(calls: Recorded[]): string {
  return JSON.stringify(calls, (_k, v) => {
    if (v && typeof v === "object" && v.type === "Buffer" && Array.isArray(v.data)) return Buffer.from(v.data).toString("latin1");
    if (v instanceof Uint8Array) return Buffer.from(v).toString("latin1");
    return v;
  });
}

function runner(m: ReturnType<typeof mockSdk>, tokens = new TokenStore(), extra: Partial<ConstructorParameters<typeof BlaxelRunner>[0]> = {}) {
  const logs: string[] = [];
  const r = new BlaxelRunner({ config, tokens, sdk: m.sdk, log: (s) => logs.push(s), pollMs: 5, ...extra });
  return { r, logs, tokens };
}

describe("BlaxelRunner", () => {
  it("runs the resume-fork in a sandbox and returns verified quotes plus the test tail", async () => {
    const testLog = Array.from({ length: 60 }, (_, i) => `test line ${i + 1}`).join("\n");
    const m = mockSdk({
      ghost: () => ({ status: "completed", exitCode: 0, stdout: claudeStdout(), stderr: "" }),
      tests: () => ({ status: "completed", exitCode: 0, logs: testLog }),
    });
    const { r, tokens } = runner(m);
    const res = await r.run(input());

    expect(res.runner).toBe("blaxel");
    expect(res.answer).toBe("You asked me to remember pineapple.");
    expect(res.quotes).toEqual([
      { text: "Remember the word pineapple.", verified: true },
      { text: "the secret code word is mango", verified: false },
    ]);
    expect(res.confidence).toBe("high");
    expect(res.costUsd).toBe(0.21);
    expect(res.runId).toMatch(/^[0-9a-f]{12}$/);
    const tail = res.testOutput!.split("\n");
    expect(tail).toHaveLength(40);
    expect(tail[0]).toBe("test line 22");
    expect(tail.at(-2)).toBe("test line 60");
    expect(tail.at(-1)).toBe("(npm test exited 0)");

    // sandbox created from the Claude Code image with a ttl safety net, then deleted
    expect(m.creates[0]).toMatchObject({ image: "blaxel/claude-code:latest", ttl: "10m", name: `seance-ghost-${res.runId}` });
    expect(m.deleted).toBe(1);
    // the token was revoked when the run ended
    expect(m.execs.find((e) => e.name === "seance-ghost")!.env!.ANTHROPIC_API_KEY).toMatch(/^sgt_/);
    expect(tokens.check(m.execs.find((e) => e.name === "seance-ghost")!.env!.ANTHROPIC_API_KEY)).toBe("unknown");
  });

  it("never sends GHOSTS_API_KEY (or the Blaxel key) to the sandbox in any SDK call", async () => {
    const m = mockSdk({ ghost: () => ({ status: "completed", exitCode: 0, stdout: claudeStdout() }) });
    await runner(m).r.run(input());
    const all = dump(m.calls);
    expect(all.length).toBeGreaterThan(1000); // the dump really includes the uploads
    expect(all).not.toContain(FAKE_KEY);
    expect(all).not.toContain(FAKE_BL_KEY);
    for (const e of m.execs) expect(JSON.stringify(e.env ?? {})).not.toContain("GHOSTS");
  });

  it("gives the ghost exactly the gateway env and the Blaxel tool set", async () => {
    const m = mockSdk({ ghost: () => ({ status: "completed", exitCode: 0, stdout: claudeStdout() }) });
    await runner(m).r.run(input());
    const ghost = m.execs.find((e) => e.name === "seance-ghost")!;
    expect(Object.keys(ghost.env!).sort()).toEqual(
      ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CONFIG_DIR", "HOME", "PATH", "SEANCE_GHOST"].sort(),
    );
    expect(ghost.env!.ANTHROPIC_BASE_URL).toBe(`${PUBLIC}/llm`);
    expect(ghost.env!.CLAUDE_CONFIG_DIR).toBe(SANDBOX_CLAUDE_DIR);
    expect(ghost.env!.SEANCE_GHOST).toBe("1");
    expect(ghost.workingDir).toBe(SANDBOX_REPO);
    expect(ghost.keepAlive).toBe(true);
    expect(ghost.timeout).toBeGreaterThan(60);
    expect(ghost.timeout).toBeLessThanOrEqual(120);

    // The shell command, run through a real sh with `claude` swapped for printf, yields exactly ghostArgs.
    const prompt = buildGhostPrompt({ from: "judge@example.com", file: "retry.py", line: 1, question: input().question });
    const expected = ghostArgs(prompt, SESSION_ID, "sonnet", { allowed: BLAXEL_ALLOWED_TOOLS, disallowed: "Edit,MultiEdit,Write,NotebookEdit,WebFetch,WebSearch" });
    expect(ghost.command.startsWith("claude ")).toBe(true);
    const argv = execFileSync("sh", ["-c", `printf '%s\\0' ${ghost.command.slice("claude ".length)}`]).toString().split("\0").slice(0, -1);
    expect(argv).toEqual(expected);
    expect(argv).toContain("--fork-session");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob,Bash(npm test:*)");
    expect(argv[argv.indexOf("--disallowedTools") + 1]).not.toMatch(/(^|,)Bash(,|$)/);
  });

  it("uploads the repo at the session's last commit and the transcript at the encoded cwd path", async () => {
    const m = mockSdk({ ghost: () => ({ status: "completed", exitCode: 0, stdout: claudeStdout() }) });
    await runner(m).r.run(input());
    const tarPath = [...m.files.keys()].find((k) => k.endsWith(".tar"))!;
    const jsonlPath = [...m.files.keys()].find((k) => k.endsWith(".jsonl"))!;
    expect(m.files.get(jsonlPath)!.equals(fs.readFileSync(PINEAPPLE))).toBe(true);

    const local = path.join(root, "x.tar");
    fs.writeFileSync(local, m.files.get(tarPath)!);
    const out = path.join(root, "x");
    fs.mkdirSync(out, { recursive: true });
    execFileSync("tar", ["-xf", local, "-C", out]);
    expect(fs.readFileSync(path.join(out, "retry.py"), "utf8")).toBe("RETRY_BASE_DELAY = 0.37\n"); // not HEAD's 0.25

    const setup = m.execs.find((e) => e.name === "seance-setup")!.command;
    expect(setup).toContain(`tar -xf ${tarPath} -C '/seance/repo'`);
    expect(setup).toContain(`mv ${jsonlPath} '/seance/claude/projects/-seance-repo/${SESSION_ID}.jsonl'`);
    expect(setup).toContain("command -v claude");
    // npm install before the ghost; our npm test ran too
    const names = m.execs.map((e) => e.name);
    expect(names.indexOf("seance-npm-install")).toBeLessThan(names.indexOf("seance-ghost"));
    expect(names).toContain("seance-npm-test");
  });

  it("asks Blaxel to limit egress to the gateway host and npm, and falls back to an open sandbox if refused", async () => {
    const m1 = mockSdk({ ghost: () => ({ status: "completed", exitCode: 0, stdout: claudeStdout() }) });
    await runner(m1).r.run(input());
    expect(m1.creates[0].network).toEqual({
      allowedDomains: ["seance-test.trycloudflare.com", "registry.npmjs.org"],
      firewall: { rulesets: ["proxy"] },
      proxy: { routing: [] },
    });

    const m2 = mockSdk({ refuseNetwork: true, ghost: () => ({ status: "completed", exitCode: 0, stdout: claudeStdout() }) });
    const { r, logs } = runner(m2);
    const res = await r.run(input());
    expect(res.answer).toContain("pineapple");
    expect(m2.creates).toHaveLength(2);
    expect(m2.creates[1].network).toBeUndefined();
    expect(logs.join("\n")).toMatch(/egress-restricted sandbox refused/);

    const m3 = mockSdk({ ghost: () => ({ status: "completed", exitCode: 0, stdout: claudeStdout() }) });
    await runner(m3, new TokenStore(), { restrictEgress: false }).r.run(input());
    expect(m3.creates[0].network).toBeUndefined();
  });

  it("pins a Claude Code version when asked", async () => {
    const m = mockSdk({ ghost: () => ({ status: "completed", exitCode: 0, stdout: claudeStdout() }) });
    await runner(m, new TokenStore(), { claudeVersion: "2.1.302" }).r.run(input());
    expect(m.execs.find((e) => e.name === "seance-setup")!.command).toContain("'@anthropic-ai/claude-code@2.1.302'");
  });

  it("throws a GhostError, deletes the sandbox and revokes the token when claude fails", async () => {
    let token = "";
    const m = mockSdk({
      ghost: (req) => {
        token = req.env!.ANTHROPIC_API_KEY;
        return { status: "failed", exitCode: 1, stdout: "", stderr: `auth failed for ${req.env!.ANTHROPIC_API_KEY}` };
      },
    });
    const tokens = new TokenStore();
    const err = await runner(m, tokens).r.run(input()).catch((e) => e);
    expect(err).toBeInstanceOf(GhostError);
    expect(err.message).toMatch(/claude exited with 1/);
    expect(err.message).not.toContain(token);
    expect(m.deleted).toBe(1);
    expect(tokens.check(token)).toBe("unknown");
  });

  it("times out as a whole, kills the ghost and still deletes the sandbox", async () => {
    const m = mockSdk({ ghost: () => "hang", tests: () => "hang" });
    const t0 = Date.now();
    const err = await runner(m, new TokenStore(), { timeoutMs: 300 }).r.run(input()).catch((e) => e);
    expect(err).toBeInstanceOf(GhostError);
    expect(err.message).toMatch(/timed out after 0s while waiting for seance-ghost/);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(m.killed).toContain("seance-ghost");
    expect(m.deleted).toBe(1);
  });

  it("does not wait long for a hanging npm test once the ghost has answered", async () => {
    const m = mockSdk({ ghost: () => ({ status: "completed", exitCode: 0, stdout: claudeStdout() }), tests: () => "hang" });
    const { r } = runner(m, new TokenStore(), { timeoutMs: 400 });
    const res = await r.run(input());
    expect(res.answer).toContain("pineapple");
    expect(res.testOutput).toBeUndefined();
  });

  it("fails setup clearly and falls back to deleting by name if sandbox.delete() fails", async () => {
    const m = mockSdk({ setup: () => ({ status: "failed", exitCode: 2, logs: "tar: bad archive" }), deleteFails: true });
    const err = await runner(m).r.run(input()).catch((e) => e);
    expect(err).toBeInstanceOf(GhostError);
    expect(err.message).toMatch(/sandbox setup failed \(exit 2\): tar: bad archive/);
    expect(m.calls.some((c) => c.method === "deleteSandbox")).toBe(true);
  });

  it("still runs with the transcript only when the repo is gone", async () => {
    const m = mockSdk({ ghost: () => ({ status: "completed", exitCode: 0, stdout: claudeStdout() }) });
    const res = await runner(m).r.run(input(path.join(root, "missing")));
    expect(res.answer).toContain("pineapple");
    expect([...m.files.keys()].some((k) => k.endsWith(".tar"))).toBe(false);
    expect(m.execs.map((e) => e.name)).not.toContain("seance-npm-test");
    expect(res.testOutput).toBeUndefined();
  });
});

describe("configuration errors", () => {
  const bare = (env: Record<string, string>) => loadConfig({ envFile: null, env });

  it("names BL_WORKSPACE and BL_API_KEY when Blaxel credentials are missing", () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "seance-home-"));
    try {
      const c = bare({ GHOSTS_API_KEY: FAKE_KEY, PUBLIC_URL: PUBLIC });
      expect(blaxelCredentialProblem(c, emptyHome)).toMatch(/BL_WORKSPACE and BL_API_KEY/);
      expect(blaxelCredentialProblem(bare({ BL_WORKSPACE: "ws" }), emptyHome)).toMatch(/set BL_API_KEY in/);
      expect(blaxelCredentialProblem(bare({ BL_WORKSPACE: "ws", BL_API_KEY: "k" }), emptyHome)).toBeNull();
      fs.mkdirSync(path.join(emptyHome, ".blaxel"));
      fs.writeFileSync(path.join(emptyHome, ".blaxel", "config.yaml"), "context: {}\n");
      expect(blaxelCredentialProblem(c, emptyHome)).toBeNull();
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it("requires PUBLIC_URL, GHOSTS_API_KEY and the TokenStore", () => {
    const tokens = new TokenStore();
    const sdk = mockSdk().sdk;
    expect(() => new BlaxelRunner({ config: bare({ GHOSTS_API_KEY: FAKE_KEY }), tokens, sdk })).toThrow(/PUBLIC_URL/);
    expect(() => new BlaxelRunner({ config: bare({ PUBLIC_URL: PUBLIC }), tokens, sdk })).toThrow(/GHOSTS_API_KEY/);
    expect(() => new BlaxelRunner({ config, tokens: undefined as any, sdk })).toThrow(/TokenStore/);
  });

  it("createGhostRunner('blaxel') needs opts.tokens and builds a runner with it", () => {
    const c = { ...config, ghostRunner: "blaxel" as const };
    expect(() => createGhostRunner(c)).toThrow(/createGhostRunner\(config, \{ tokens \}\)/);
    expect(createGhostRunner(c, { tokens: new TokenStore(), blaxel: { sdk: mockSdk().sdk } })).toBeTruthy();
  });

  it("shellJoin quotes single quotes safely", () => {
    const argv = ["-p", "it's \"fine\" $(rm -rf /) `x` \\ \n new line"];
    const out = execFileSync("sh", ["-c", `printf '%s\\0' ${shellJoin(argv)}`]).toString().split("\0").slice(0, -1);
    expect(out).toEqual(argv);
  });
});
