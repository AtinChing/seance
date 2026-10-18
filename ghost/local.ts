import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getConfig, type SeanceConfig } from "../config/index.ts";
import { lastCommitForSession } from "../shared/git.ts";
import type { GhostRunner } from "../shared/interfaces.ts";
import type { GhostResult } from "../shared/types.ts";
import { GhostError, redact } from "./errors.ts";
import { parseGhostOutput } from "./parse.ts";
import { buildGhostPrompt } from "./prompt.ts";
import { verifyQuotes } from "./verify.ts";

const execFileP = promisify(execFile);

export type GhostRunInput = Parameters<GhostRunner["run"]>[0];

/** Claude Code's project folder name for a cwd: the realpath with every non-alphanumeric char replaced by "-". */
export function encodeCwd(cwd: string): string {
  let real = cwd;
  try {
    real = fs.realpathSync(cwd);
  } catch {
    // path does not exist (yet): encode it as given
  }
  return real.replace(/[^a-zA-Z0-9]/g, "-");
}

export const ALLOWED_TOOLS = "Read,Grep,Glob";
export const DISALLOWED_TOOLS = "Bash,Edit,MultiEdit,Write,WebFetch,WebSearch";

/** The exact claude argv for a ghost run (verified in M0). */
export function ghostArgs(prompt: string, sessionId: string, model: string): string[] {
  return [
    "-p", prompt,
    "--resume", sessionId,
    "--fork-session",
    "--setting-sources", "user",
    "--model", model,
    "--allowedTools", ALLOWED_TOOLS,
    "--disallowedTools", DISALLOWED_TOOLS,
    "--max-turns", "10",
    "--output-format", "json",
  ];
}

export interface LocalRunnerOptions {
  config?: SeanceConfig;
  /** Path or name of the claude binary. Tests point this at a fake script. */
  claudeBin?: string;
  /** Default: SEANCE_GHOST_MODEL or "sonnet". */
  model?: string;
  /** Default 90 s. */
  timeoutMs?: number;
  /** Where per-run worktrees go. Default /tmp/seance. */
  tmpRoot?: string;
  log?: (msg: string) => void;
}

interface SpawnOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const defaultLog = (m: string) => console.error(`[ghost] ${m}`);

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", repo, ...args], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

export class LocalRunner implements GhostRunner {
  private readonly config: SeanceConfig;
  private readonly claudeBin: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly tmpRoot: string;
  private readonly log: (msg: string) => void;

  constructor(opts: LocalRunnerOptions = {}) {
    this.config = opts.config ?? getConfig();
    this.claudeBin = opts.claudeBin ?? "claude";
    this.model = opts.model ?? (this.config.raw.SEANCE_GHOST_MODEL || "sonnet");
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.tmpRoot = opts.tmpRoot ?? "/tmp/seance";
    this.log = opts.log ?? defaultLog;
  }

  async run(input: GhostRunInput): Promise<GhostResult> {
    const started = Date.now();
    const runId = randomBytes(6).toString("hex");
    const ghostsKey = this.config.ghostsApiKey;
    if (!ghostsKey) throw new GhostError("GHOSTS_API_KEY is not set, so the local ghost cannot start");
    if (!fs.existsSync(input.transcriptLocalPath))
      throw new GhostError(`transcript snapshot not found: ${input.transcriptLocalPath}`);

    const ghostHome = path.join(this.config.dataDir, "ghost-home", runId);
    const runDir = path.join(this.tmpRoot, runId);
    const worktree = path.join(runDir, "repo");
    const repo = input.session.repoPath;
    let worktreeMade = false;

    try {
      // 1. Worktree at the session's last commit (fallback: HEAD; fallback: the repo itself).
      let cwd = repo;
      try {
        fs.mkdirSync(runDir, { recursive: true });
        const commit = (await lastCommitForSession(repo, input.session.shortId).catch(() => null)) ?? (await git(repo, ["rev-parse", "HEAD"]));
        await git(repo, ["worktree", "add", "--detach", worktree, commit]);
        worktreeMade = true;
        cwd = worktree;
        this.log(`run ${runId}: worktree at ${commit.slice(0, 12)}`);
      } catch (e) {
        this.log(`run ${runId}: could not make a worktree (${(e as Error).message.split("\n")[0]}); using repoPath as cwd`);
      }
      if (!fs.existsSync(cwd)) throw new GhostError(`ghost cwd does not exist: ${cwd}`);
      cwd = fs.realpathSync(cwd);

      // 2. Isolated config dir with the transcript at the encoded path for that cwd.
      const projectDir = path.join(ghostHome, "projects", encodeCwd(cwd));
      fs.mkdirSync(projectDir, { recursive: true });
      fs.copyFileSync(input.transcriptLocalPath, path.join(projectDir, `${input.session.sessionId}.jsonl`));

      // 3. Spawn the fork.
      const prompt = buildGhostPrompt({ from: input.from, file: input.file, line: input.line, question: input.question });
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
        CLAUDE_CONFIG_DIR: ghostHome,
        ANTHROPIC_API_KEY: ghostsKey,
        SEANCE_GHOST: "1",
      };
      const out = await this.spawnClaude(ghostArgs(prompt, input.session.sessionId, this.model), cwd, env);
      const clean = (s: string) => redact(s, [ghostsKey]).trim().slice(-500);

      if (out.timedOut) throw new GhostError(`claude timed out after ${Math.round(this.timeoutMs / 1000)}s and was killed`);
      let data: Record<string, any> | null = null;
      try {
        data = JSON.parse(out.stdout.trim());
      } catch {
        data = null;
      }
      if (out.code !== 0) {
        const detail = data?.result ? String(data.result) : out.stderr || out.stdout;
        throw new GhostError(`claude exited with ${out.code ?? out.signal}: ${clean(detail)}`);
      }
      if (!data || typeof data !== "object") throw new GhostError(`claude printed unparseable output: ${clean(out.stdout) || "(empty)"}`);
      if (data.is_error) throw new GhostError(`claude reported an error (${data.subtype ?? "unknown"}): ${clean(String(data.result ?? ""))}`);
      if (typeof data.result !== "string") throw new GhostError("claude output has no result text");

      // 4. Parse and verify against the ORIGINAL snapshot, never the fork.
      const parsed = parseGhostOutput(data.result);
      const quotes = await verifyQuotes(parsed.quotes, input.transcriptLocalPath);
      const costUsd = typeof data.total_cost_usd === "number" ? data.total_cost_usd : undefined;
      this.log(`run ${runId}: answered via local claude in ${Date.now() - started}ms, cost $${costUsd ?? "?"}, ${quotes.filter((q) => q.verified).length}/${quotes.length} quotes verified`);
      return { ...parsed, quotes, runId, runner: "local", durationMs: Date.now() - started, costUsd };
    } catch (e) {
      if (e instanceof GhostError) throw e;
      throw new GhostError(`local ghost failed: ${redact((e as Error)?.message ?? String(e), [ghostsKey])}`, { cause: e });
    } finally {
      if (this.config.debug) {
        this.log(`run ${runId}: SEANCE_DEBUG=1, keeping ${ghostHome} and ${runDir}`);
      } else {
        if (worktreeMade) {
          await git(repo, ["worktree", "remove", "--force", worktree]).catch((e) => this.log(`run ${runId}: worktree remove failed: ${(e as Error).message.split("\n")[0]}`));
        }
        await git(repo, ["worktree", "prune"]).catch(() => {});
        fs.rmSync(ghostHome, { recursive: true, force: true });
        fs.rmSync(runDir, { recursive: true, force: true });
      }
    }
  }

  /** Spawn claude in its own process group with stdin closed; SIGKILL the group on timeout. */
  private spawnClaude(args: string[], cwd: string, env: Record<string, string>): Promise<SpawnOutcome> {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.claudeBin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      } catch (e) {
        reject(new GhostError(`could not start ${this.claudeBin}: ${(e as Error).message}`));
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr!.setEncoding("utf8").on("data", (d: string) => {
        if (stderr.length < 64 * 1024) stderr += d;
      });
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
        // If something outside the group still holds the pipes open, do not wait on it forever.
        setTimeout(() => resolve({ code: null, signal: "SIGKILL", stdout, stderr, timedOut }), 2000).unref();
      }, this.timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new GhostError(`could not start ${this.claudeBin}: ${e.message}`));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) kill(); // reap any grandchildren still in the group
        resolve({ code, signal, stdout, stderr, timedOut });
      });
    });
  }
}
