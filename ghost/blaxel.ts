/**
 * Blaxel ghost runner (SPEC 6.7): the same resume-fork as the local runner, but inside a throwaway Blaxel sandbox.
 *
 * Per run:
 *   1. mint a short-lived gateway token (the sandbox never sees GHOSTS_API_KEY);
 *   2. create a sandbox from an image with Node + Claude Code (default blaxel/claude-code:latest), with egress
 *      limited to the PUBLIC_URL host and the npm registry when Blaxel's proxy allows it;
 *   3. upload `git archive <session's last commit>` and the transcript JSONL at the encoded path for the cwd;
 *   4. npm install, then run the ghost (`claude -p … --resume <id> --fork-session`, tools Read/Grep/Glob plus
 *      `Bash(npm test:*)`) and our own `npm test` side by side;
 *   5. parse + verify quotes against the ORIGINAL local snapshot; attach the test tail as `testOutput`;
 *   6. delete the sandbox and revoke the token, whatever happened.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getConfig, type SeanceConfig } from "../config/index.ts";
import { lastCommitForSession } from "../shared/git.ts";
import type { GhostRunner } from "../shared/interfaces.ts";
import type { GhostResult } from "../shared/types.ts";
import { GhostError, redact } from "./errors.ts";
import { encodePath, ghostArgs, interpretClaudeRun, type GhostRunInput } from "./local.ts";
import { parseGhostOutput } from "./parse.ts";
import { buildGhostPrompt } from "./prompt.ts";
import { verifyQuotes } from "./verify.ts";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------------------------------------------
// The slice of @blaxel/core this runner uses (shapes copied from its .d.ts, so tests can pass a mock)
// ---------------------------------------------------------------------------------------------------------------

/** @blaxel/core ProcessRequest (subset). */
export interface BlaxelProcessRequest {
  command: string;
  name?: string;
  env?: Record<string, string>;
  workingDir?: string;
  waitForCompletion?: boolean;
  /** Seconds. With keepAlive, the process is killed after this long. */
  timeout?: number;
  keepAlive?: boolean;
}

/** @blaxel/core ProcessResponse (subset). */
export interface BlaxelProcessResult {
  name?: string;
  pid?: string;
  status?: "failed" | "killed" | "stopped" | "running" | "completed" | string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  logs?: string;
}

/** @blaxel/core SandboxInstance (subset). */
export interface BlaxelSandbox {
  fs: { writeBinary(path: string, content: Uint8Array): Promise<unknown> };
  process: {
    exec(req: BlaxelProcessRequest): Promise<BlaxelProcessResult>;
    wait(identifier: string, opts?: { maxWait?: number; interval?: number }): Promise<BlaxelProcessResult>;
    kill(identifier: string): Promise<unknown>;
  };
  delete(): Promise<unknown>;
}

/** @blaxel/core SandboxCreateConfiguration (subset). */
export interface BlaxelCreateConfig {
  name: string;
  image: string;
  memory?: number;
  region?: string;
  ttl?: string;
  labels?: Record<string, string>;
  network?: {
    allowedDomains?: string[];
    firewall?: { rulesets?: string[] };
    proxy?: { routing?: unknown[]; bypass?: string[] };
  };
}

export interface BlaxelSdk {
  createSandbox(config: BlaxelCreateConfig, opts?: { timeout?: number }): Promise<BlaxelSandbox>;
  /** Fallback teardown by name, used if `sandbox.delete()` fails. */
  deleteSandbox(name: string): Promise<unknown>;
}

/** What the runner needs from the server's gateway TokenStore (server/llm.ts satisfies this structurally). */
export interface RunTokenIssuer {
  mint(runId: string, opts?: { ttlMs?: number; budgetUsd?: number }): string;
  revoke?(token: string): void;
  spentUsd?(token: string): number | undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Credentials and the real SDK
// ---------------------------------------------------------------------------------------------------------------

/** Settings the Blaxel SDK authenticates with (any one complete set works). */
export const BLAXEL_SETTINGS = ["BL_WORKSPACE", "BL_API_KEY"] as const;

/** Null when Blaxel credentials are available (env/.env, or a `bl login` config file), else a clear message. */
export function blaxelCredentialProblem(config: SeanceConfig, homeDir: string = os.homedir()): string | null {
  const r = config.raw;
  if (r.BL_WORKSPACE && (r.BL_API_KEY || r.BL_CLIENT_CREDENTIALS)) return null;
  if (fs.existsSync(path.join(homeDir, ".blaxel", "config.yaml"))) return null;
  const missing = BLAXEL_SETTINGS.filter((k) => !r[k]);
  return (
    `Blaxel credentials missing: set ${missing.join(" and ")} in ${path.join("<seance>", ".env")} ` +
    "(workspace name and an API key from app.blaxel.ai), or run `bl login <workspace>` on this machine"
  );
}

/** Loads @blaxel/core lazily (so local mode never imports it) and points it at our credentials. */
export async function loadBlaxelSdk(config: SeanceConfig): Promise<BlaxelSdk> {
  const mod = await import("@blaxel/core");
  const r = config.raw;
  if (r.BL_API_KEY && r.BL_WORKSPACE) mod.initialize({ apiKey: r.BL_API_KEY, workspace: r.BL_WORKSPACE });
  return {
    createSandbox: async (c, o) => (await mod.SandboxInstance.create(c as any, o)) as unknown as BlaxelSandbox,
    deleteSandbox: (name) => mod.SandboxInstance.delete(name),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------------------------

/** Tools in Blaxel mode: read-only plus re-running the tests as evidence. Bash is NOT disallowed (deny wins). */
export const BLAXEL_ALLOWED_TOOLS = "Read,Grep,Glob,Bash(npm test:*)";
export const BLAXEL_DISALLOWED_TOOLS = "Edit,MultiEdit,Write,NotebookEdit,WebFetch,WebSearch";

/** Fixed layout inside the sandbox. No symlinks, so the encoded-cwd rule applies to these paths as written. */
export const SANDBOX_ROOT = "/seance";
export const SANDBOX_REPO = `${SANDBOX_ROOT}/repo`;
export const SANDBOX_HOME = `${SANDBOX_ROOT}/home`;
export const SANDBOX_CLAUDE_DIR = `${SANDBOX_ROOT}/claude`;
export const SANDBOX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** Uploads land directly in /tmp (it exists in every image; Blaxel may not create parent dirs on write). */
const STAGE = "/tmp/seance-upload";

export const NPM_REGISTRY_HOST = "registry.npmjs.org";
export const TEST_TAIL_LINES = 40;
/** How long to wait for our `npm test` after the ghost has answered. */
export const TEST_GRACE_MS = 20_000;

export interface BlaxelRunnerOptions {
  config?: SeanceConfig;
  tokens: RunTokenIssuer;
  /** Public base URL of the Séance server (the sandbox reaches the gateway at `${publicUrl}/llm`). Default PUBLIC_URL. */
  publicUrl?: string;
  /** Injected SDK (tests). Default: @blaxel/core, loaded on first run. */
  sdk?: BlaxelSdk | (() => Promise<BlaxelSdk>);
  /** Default SEANCE_BLAXEL_IMAGE or "blaxel/claude-code:latest" (Node 24 + Claude Code). */
  image?: string;
  /** Default SEANCE_GHOST_MODEL or "sonnet". */
  model?: string;
  /** Install this exact @anthropic-ai/claude-code version in the sandbox. Default SEANCE_BLAXEL_CLAUDE_VERSION (unset: use the image's). */
  claudeVersion?: string;
  /** Default BL_REGION (unset: Blaxel's default). */
  region?: string;
  /** MB. Default SEANCE_BLAXEL_MEMORY or 4096. */
  memory?: number;
  /** Ask Blaxel to limit egress to PUBLIC_URL's host + the npm registry. Default true (SEANCE_BLAXEL_EGRESS=open turns it off). */
  restrictEgress?: boolean;
  /** Whole-run deadline. Default 120 s. */
  timeoutMs?: number;
  tokenTtlMs?: number;
  tokenBudgetUsd?: number;
  /** Poll interval for sandbox processes. Default 1000 ms. */
  pollMs?: number;
  log?: (msg: string) => void;
}

const defaultLog = (m: string) => console.error(`[ghost] ${m}`);

/** POSIX single-quote a word for `sh`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

function lastLines(text: string, n: number): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.slice(-n).join("\n");
}

class DeadlineError extends Error {}

export class BlaxelRunner implements GhostRunner {
  private readonly config: SeanceConfig;
  private readonly tokens: RunTokenIssuer;
  private readonly publicUrl: string;
  private readonly image: string;
  private readonly model: string;
  private readonly claudeVersion?: string;
  private readonly region?: string;
  private readonly memory: number;
  private readonly restrictEgress: boolean;
  private readonly timeoutMs: number;
  private readonly tokenTtlMs: number;
  private readonly tokenBudgetUsd: number;
  private readonly pollMs: number;
  private readonly log: (msg: string) => void;
  private sdkSource: BlaxelSdk | (() => Promise<BlaxelSdk>) | undefined;
  private sdkPromise?: Promise<BlaxelSdk>;

  constructor(opts: BlaxelRunnerOptions) {
    this.config = opts.config ?? getConfig();
    const raw = this.config.raw;
    if (!opts.tokens) throw new Error("BlaxelRunner needs the server's gateway TokenStore (opts.tokens)");
    this.tokens = opts.tokens;
    const publicUrl = (opts.publicUrl ?? this.config.publicUrl ?? "").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(publicUrl)) throw new Error("BlaxelRunner needs PUBLIC_URL (the sandbox reaches the model gateway at ${PUBLIC_URL}/llm)");
    this.publicUrl = publicUrl;
    if (!this.config.ghostsApiKey) throw new Error("BlaxelRunner needs GHOSTS_API_KEY on the server (the gateway uses it; the sandbox never sees it)");
    if (!opts.sdk) {
      const problem = blaxelCredentialProblem(this.config);
      if (problem) throw new Error(problem);
    }
    this.sdkSource = opts.sdk;
    this.image = opts.image ?? (raw.SEANCE_BLAXEL_IMAGE || "blaxel/claude-code:latest");
    this.model = opts.model ?? (raw.SEANCE_GHOST_MODEL || "sonnet");
    const cv = opts.claudeVersion ?? (raw.SEANCE_BLAXEL_CLAUDE_VERSION || undefined);
    if (cv && !/^[0-9A-Za-z.\-]+$/.test(cv)) throw new Error(`SEANCE_BLAXEL_CLAUDE_VERSION looks wrong: ${cv}`);
    this.claudeVersion = cv;
    this.region = opts.region ?? (raw.BL_REGION || undefined);
    this.memory = opts.memory ?? (Number(raw.SEANCE_BLAXEL_MEMORY) || 4096);
    this.restrictEgress = opts.restrictEgress ?? raw.SEANCE_BLAXEL_EGRESS !== "open";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.tokenTtlMs = opts.tokenTtlMs ?? 180_000;
    this.tokenBudgetUsd = opts.tokenBudgetUsd ?? 0.5;
    this.pollMs = opts.pollMs ?? 1000;
    this.log = opts.log ?? defaultLog;
  }

  private sdk(): Promise<BlaxelSdk> {
    if (!this.sdkPromise) {
      const src = this.sdkSource;
      this.sdkPromise = typeof src === "function" ? src() : src ? Promise.resolve(src) : loadBlaxelSdk(this.config);
      this.sdkPromise.catch(() => (this.sdkPromise = undefined));
    }
    return this.sdkPromise;
  }

  /** The sandbox env for the ghost: exactly these keys, and never the real key. */
  ghostEnv(token: string): Record<string, string> {
    return {
      PATH: SANDBOX_PATH,
      HOME: SANDBOX_HOME,
      CLAUDE_CONFIG_DIR: SANDBOX_CLAUDE_DIR,
      ANTHROPIC_BASE_URL: `${this.publicUrl}/llm`,
      ANTHROPIC_API_KEY: token,
      SEANCE_GHOST: "1",
      // Not a secret: stops Claude Code's telemetry/update calls, which egress filtering would block anyway.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
  }

  /** Blaxel network config: allowlist our gateway host + npm, enforced by the proxy firewall ruleset. */
  networkConfig(): BlaxelCreateConfig["network"] {
    const host = new URL(this.publicUrl).hostname;
    return { allowedDomains: [host, NPM_REGISTRY_HOST], firewall: { rulesets: ["proxy"] }, proxy: { routing: [] } };
  }

  async run(input: GhostRunInput): Promise<GhostResult> {
    const started = Date.now();
    const deadline = started + this.timeoutMs;
    const runId = randomBytes(6).toString("hex");
    const ghostsKey = this.config.ghostsApiKey;
    const secrets = [ghostsKey, this.config.raw.BL_API_KEY, this.config.raw.BL_CLIENT_CREDENTIALS];
    if (!fs.existsSync(input.transcriptLocalPath)) throw new GhostError(`transcript snapshot not found: ${input.transcriptLocalPath}`);

    const token = this.tokens.mint(runId, { ttlMs: this.tokenTtlMs, budgetUsd: this.tokenBudgetUsd });
    secrets.push(token);
    const clean = (s: string) => redact(s, secrets);
    const name = `seance-ghost-${runId}`;
    let sandbox: BlaxelSandbox | null = null;
    let sdk: BlaxelSdk | null = null;

    const remaining = () => deadline - Date.now();
    const within = <T>(p: Promise<T>, what: string): Promise<T> => {
      const ms = remaining();
      if (ms <= 0) return Promise.reject(new DeadlineError(what));
      let t: ReturnType<typeof setTimeout>;
      return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new DeadlineError(what)), ms)))]).finally(() => clearTimeout(t));
    };

    try {
      // 1. Local inputs: the repo at the session's last commit, and the transcript bytes.
      const transcript = fs.readFileSync(input.transcriptLocalPath);
      const tar = await this.archiveRepo(input, runId);

      // 2. Sandbox.
      sdk = await within(this.sdk(), "loading the Blaxel SDK");
      sandbox = await within(this.createSandbox(sdk, name, runId), "creating the sandbox");
      const sb = sandbox;
      this.log(`run ${runId}: sandbox ${name} ready (${this.image}) after ${Date.now() - started}ms`);

      // 3. Upload, unpack, place the transcript, make sure claude is there.
      const projectDir = `${SANDBOX_CLAUDE_DIR}/projects/${encodePath(SANDBOX_REPO)}`;
      const transcriptDest = `${projectDir}/${input.session.sessionId}.jsonl`;
      if (tar) await within(sb.fs.writeBinary(`${STAGE}-repo.tar`, tar), "uploading the repo");
      await within(sb.fs.writeBinary(`${STAGE}-transcript.jsonl`, transcript), "uploading the transcript");
      const setup = [
        `mkdir -p ${shellQuote(SANDBOX_REPO)} ${shellQuote(SANDBOX_HOME)} ${shellQuote(projectDir)}`,
        tar ? `tar -xf ${STAGE}-repo.tar -C ${shellQuote(SANDBOX_REPO)}` : "true",
        `mv ${STAGE}-transcript.jsonl ${shellQuote(transcriptDest)}`,
        `rm -f ${STAGE}-repo.tar`,
        this.claudeVersion
          ? `npm install -g --no-audit --no-fund --loglevel=error ${shellQuote(`@anthropic-ai/claude-code@${this.claudeVersion}`)}`
          : "command -v claude >/dev/null 2>&1 || npm install -g --no-audit --no-fund --loglevel=error @anthropic-ai/claude-code",
        "claude --version",
      ].join(" && ");
      const setupRes = await this.exec(sb, "seance-setup", setup, { PATH: SANDBOX_PATH, HOME: SANDBOX_HOME }, "/", remaining, within);
      if (setupRes.exitCode !== 0) throw new GhostError(`sandbox setup failed (exit ${setupRes.exitCode}): ${clean(lastLines(output(setupRes), 8))}`);
      this.log(`run ${runId}: uploaded ${tar ? `${tar.length} B repo + ` : ""}${transcript.length} B transcript, claude ${output(setupRes).trim().split("\n").pop()}`);

      // 4. npm install (so both the ghost's and our `npm test` can run), then the ghost and our test run side by side.
      const hasPackage = tar ? await this.hasPackageJson(sb, remaining, within) : false;
      const plainEnv = { PATH: SANDBOX_PATH, HOME: SANDBOX_HOME, CI: "1" };
      if (hasPackage) {
        const inst = await this.exec(sb, "seance-npm-install", "npm install --no-audit --no-fund --loglevel=error", plainEnv, SANDBOX_REPO, remaining, within);
        if (inst.exitCode !== 0) this.log(`run ${runId}: npm install exited ${inst.exitCode}; continuing`);
      }

      const prompt = buildGhostPrompt({ from: input.from, file: input.file, line: input.line, question: input.question });
      const argv = ghostArgs(prompt, input.session.sessionId, this.model, { allowed: BLAXEL_ALLOWED_TOOLS, disallowed: BLAXEL_DISALLOWED_TOOLS });
      const ghostP = this.exec(sb, "seance-ghost", `claude ${shellJoin(argv)}`, this.ghostEnv(token), SANDBOX_REPO, remaining, within);
      // Our own test run never fails the ghost: any error just means no testOutput.
      const testP: Promise<BlaxelProcessResult | null> = hasPackage
        ? this.exec(sb, "seance-npm-test", "npm test 2>&1", plainEnv, SANDBOX_REPO, remaining, within).catch((e) => {
            this.log(`run ${runId}: npm test did not finish (${clean(String((e as Error)?.message ?? e)).split("\n")[0]})`);
            return null;
          })
        : Promise.resolve(null);
      const ghost = await ghostP;
      // Once the ghost has answered, give the tests a short grace period rather than the whole deadline.
      let grace: ReturnType<typeof setTimeout> | undefined;
      const tests = await Promise.race([
        testP,
        new Promise<null>((res) => (grace = setTimeout(() => res(null), Math.max(0, Math.min(TEST_GRACE_MS, remaining()))))),
      ]).finally(() => clearTimeout(grace));

      const { text, costUsd } = interpretClaudeRun(
        { code: typeof ghost.exitCode === "number" ? ghost.exitCode : null, signal: ghost.status ?? null, stdout: ghost.stdout ?? "", stderr: ghost.stderr ?? "", timedOut: false },
        { secrets, timeoutMs: this.timeoutMs },
      );

      // 5. Parse and verify against the ORIGINAL local snapshot.
      const parsed = parseGhostOutput(text);
      const quotes = await verifyQuotes(parsed.quotes, input.transcriptLocalPath);
      const testOutput = tests
        ? clean(lastLines(`${output(tests)}\n(npm test exited ${tests.exitCode ?? tests.status})`, TEST_TAIL_LINES))
        : undefined;
      const gatewayCost = this.tokens.spentUsd?.(token);
      const cost = costUsd ?? gatewayCost;
      this.log(
        `run ${runId}: answered via blaxel in ${Date.now() - started}ms, cost $${cost?.toFixed(4) ?? "?"} (gateway counted $${gatewayCost?.toFixed(4) ?? "?"}), ` +
          `${quotes.filter((q) => q.verified).length}/${quotes.length} quotes verified`,
      );
      return { ...parsed, quotes, runId, runner: "blaxel", durationMs: Date.now() - started, costUsd: cost, testOutput };
    } catch (e) {
      if (e instanceof GhostError) throw e;
      if (e instanceof DeadlineError) throw new GhostError(`blaxel ghost timed out after ${Math.round(this.timeoutMs / 1000)}s while ${e.message}`);
      throw new GhostError(`blaxel ghost failed: ${clean((e as Error)?.message ?? String(e))}`, { cause: e });
    } finally {
      this.tokens.revoke?.(token);
      if (sandbox) {
        try {
          await sandbox.delete();
          this.log(`run ${runId}: sandbox ${name} deleted`);
        } catch (e) {
          this.log(`run ${runId}: sandbox delete failed (${clean((e as Error)?.message ?? String(e)).split("\n")[0]}); retrying by name`);
          await sdk?.deleteSandbox(name).catch(() => this.log(`run ${runId}: sandbox ${name} could not be deleted; its 10m ttl will remove it`));
        }
      } else if (sdk) {
        // creation may have timed out on our side but still happened on Blaxel's
        await sdk.deleteSandbox(name).catch(() => {});
      }
    }
  }

  /** `git archive` of the session's last commit (fallback HEAD). Null if the repo is unavailable. */
  private async archiveRepo(input: GhostRunInput, runId: string): Promise<Buffer | null> {
    const repo = input.session.repoPath;
    try {
      const commit =
        (await lastCommitForSession(repo, input.session.shortId).catch(() => null)) ??
        (await execFileP("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      const { stdout } = await execFileP("git", ["-C", repo, "archive", "--format=tar", commit], {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      });
      this.log(`run ${runId}: repo snapshot at ${commit.slice(0, 12)} (${stdout.length} B)`);
      return stdout;
    } catch (e) {
      this.log(`run ${runId}: could not archive ${repo} (${(e as Error).message.split("\n")[0]}); the ghost gets the transcript only`);
      return null;
    }
  }

  private async createSandbox(sdk: BlaxelSdk, name: string, runId: string): Promise<BlaxelSandbox> {
    const base: BlaxelCreateConfig = {
      name,
      image: this.image,
      memory: this.memory,
      ttl: "10m", // safety net: Blaxel deletes it even if our teardown never runs
      labels: { app: "seance", "seance-run": runId },
      ...(this.region ? { region: this.region } : {}),
    };
    if (this.restrictEgress) {
      try {
        return await sdk.createSandbox({ ...base, network: this.networkConfig() }, { timeout: 50 });
      } catch (e) {
        // Proxy/firewall is public preview and region-dependent: fall back to an open sandbox (no secrets inside anyway).
        this.log(`run ${runId}: egress-restricted sandbox refused (${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200)}); retrying without egress limits`);
        await sdk.deleteSandbox(name).catch(() => {});
      }
    }
    return sdk.createSandbox(base, { timeout: 50 });
  }

  private async hasPackageJson(sb: BlaxelSandbox, remaining: () => number, within: Within): Promise<boolean> {
    const r = await this.exec(sb, "seance-probe", "test -f package.json", { PATH: SANDBOX_PATH }, SANDBOX_REPO, remaining, within);
    return r.exitCode === 0;
  }

  /**
   * Start a process (killed by Blaxel when the run's time is up) and poll until it ends. Not waitForCompletion:
   * Blaxel caps that at 60 s.
   */
  private async exec(
    sb: BlaxelSandbox,
    name: string,
    command: string,
    env: Record<string, string>,
    workingDir: string,
    remaining: () => number,
    within: Within,
  ): Promise<BlaxelProcessResult> {
    const secs = Math.max(1, Math.floor(remaining() / 1000));
    const started = await within(sb.process.exec({ name, command, env, workingDir, keepAlive: true, timeout: secs, waitForCompletion: false }), `starting ${name}`);
    if (started && isFinished(started)) return started;
    try {
      return await within(sb.process.wait(name, { maxWait: Math.max(1, remaining()), interval: this.pollMs }), `waiting for ${name}`);
    } catch (e) {
      await sb.process.kill(name).catch(() => {});
      throw e;
    }
  }
}

type Within = <T>(p: Promise<T>, what: string) => Promise<T>;

function isFinished(r: BlaxelProcessResult): boolean {
  return ["completed", "failed", "killed", "stopped"].includes(String(r.status)) && typeof r.exitCode === "number";
}

function output(r: BlaxelProcessResult): string {
  return r.logs || [r.stdout, r.stderr].filter(Boolean).join("\n");
}
