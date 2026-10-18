import { getConfig, SEANCE_ROOT, type SeanceConfig } from "../config/index.ts";
import { shortIdFromAddress } from "../shared/address.ts";
import { whoisLine } from "../shared/git.ts";
import type { Registry } from "../shared/interfaces.ts";
import type { SessionRecord } from "../shared/types.ts";
import type { HookContext } from "../hooks/common.ts";
import { runHook } from "../hooks/run.ts";
import { snapshotSession } from "../hooks/session-end.ts";
import { askCommand } from "./ask.ts";
import { initRepo } from "./init.ts";
import { processIo, type Io } from "./io.ts";
import { resolveFileLine } from "./target.ts";

export interface CliContext {
  cwd?: string;
  env?: Record<string, string | undefined>;
  io?: Io;
  /** Defaults to the real config (getConfig()). Tests pass loadConfig({ envFile: null, env }). */
  config?: SeanceConfig;
  /** Defaults to cli/deps.ts loadRegistry. Tests pass a fake. */
  getRegistry?: (config: SeanceConfig) => Promise<Registry>;
  /** Hook stdin. Defaults to reading process.stdin. */
  readStdin?: () => Promise<string>;
  askTimeoutMs?: number;
  now?: () => Date;
}

export const USAGE = `seance: email a dead agent. It answers.

Usage:
  seance init                              wire Séance into the current repo (idempotent)
  seance whois <file>:<line>               which session wrote this line
  seance ask <file>:<line> "<question>"    ask the session that wrote this line
  seance ask <s-xxxxxxxx@domain> "<q>"     ask a session by address
  seance ls                                list recorded sessions
  seance snapshot <shortId>                freeze a session's transcript now (if SessionEnd did not fire)
  seance migrate                           copy the JSON registry into InsForge (safe to re-run)
  seance hook <session-start|session-end|pre-edit|prepare-commit-msg>   internal hook entry points

Séance lives in ${SEANCE_ROOT}`;

export async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}

async function defaultRegistry(config: SeanceConfig): Promise<Registry> {
  const { loadRegistry } = await import("./deps.ts");
  return loadRegistry(config);
}

function pad(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ")).join("\n");
}

function shortTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function formatSessions(sessions: SessionRecord[]): string {
  if (!sessions.length) return "No sessions recorded yet. Run `seance init` in a repo, then start Claude Code there.";
  const sorted = [...sessions].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  const rows = [["SHORT ID", "ADDRESS", "REPO", "STARTED", "STATUS", "SNAPSHOT"]];
  for (const s of sorted) {
    rows.push([
      s.shortId,
      s.address,
      s.repoPath,
      shortTime(s.startedAt),
      s.endedAt ? `ended ${shortTime(s.endedAt)}` : "active",
      s.transcriptSnapshot ? "yes" : "no",
    ]);
  }
  return pad(rows);
}

async function whoisCommand(args: string[], cwd: string, io: Io): Promise<number> {
  if (args.length !== 1) {
    io.err("usage: seance whois <file>:<line>");
    return 1;
  }
  try {
    const fl = await resolveFileLine(cwd, args[0]);
    const w = await whoisLine(fl.repo, fl.rel, fl.line);
    const where = `${fl.rel}:${fl.line}`;
    if (!w.address) {
      if (w.subject === "(uncommitted)") io.out(`${where} is not committed yet, so no session is recorded for it.`);
      else io.out(`${where} was not written by a recorded agent session (no Agent-Session trailer).\n  commit   ${w.sha.slice(0, 7)}  ${w.date}\n  subject  ${w.subject}`);
      return 0;
    }
    io.out(
      [
        `${where} was written by session s-${w.shortId}`,
        `  address  ${w.address}`,
        `  short id ${w.shortId}`,
        `  commit   ${w.sha.slice(0, 7)}  ${w.date}`,
        `  subject  ${w.subject}`,
        "",
        `Ask it: seance ask ${where} "<why is this the way it is?>"`,
      ].join("\n"),
    );
    return 0;
  } catch (e) {
    io.err(`Séance: ${(e as Error).message.split("\n")[0]}`);
    return 1;
  }
}

async function snapshotCommand(args: string[], registry: Registry, io: Io, now: Date): Promise<number> {
  const raw = (args[0] ?? "").trim();
  const shortId = (shortIdFromAddress(raw) ?? raw.replace(/^s-/i, "")).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(shortId)) {
    io.err("usage: seance snapshot <shortId>   (8 hex chars, e.g. 7f3a1b2c)");
    return 1;
  }
  const rec = await registry.getSessionByShortId(shortId);
  if (!rec) {
    io.err(`Séance: no session ${shortId} in the registry (see seance ls).`);
    return 1;
  }
  const updated = await snapshotSession(registry, rec, rec.transcriptPath, now);
  io.out(`Snapshot saved for s-${shortId}: ${updated.transcriptSnapshot}${rec.endedAt ? "" : ` (marked ended ${updated.endedAt})`}`);
  return 0;
}

/** Runs the CLI and returns the process exit code. */
export async function runCli(argv: string[], ctx: CliContext = {}): Promise<number> {
  const env = ctx.env ?? process.env;
  const io = ctx.io ?? processIo;
  const cwd = ctx.cwd ?? process.cwd();
  const [cmd, ...args] = argv;

  if (cmd === "hook") {
    // Ghost forks must never register, stamp or block: bail before loading anything.
    if (env.SEANCE_GHOST === "1") return 0;
    const getRegistry = ctx.getRegistry ?? defaultRegistry;
    const r = await runHook(
      args[0] ?? "",
      args.slice(1),
      ctx.readStdin ?? readAllStdin,
      (): HookContext => {
        const config = ctx.config ?? getConfig();
        return { config, env, cwd, getRegistry: () => getRegistry(config), now: ctx.now };
      },
      env.SEANCE_DATA_DIR,
    );
    if (r.stderr) io.err(r.stderr);
    return r.code;
  }

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    io.out(USAGE);
    return cmd ? 0 : 1;
  }

  try {
    switch (cmd) {
      case "init": {
        const { repo, changes } = await initRepo(cwd);
        if (!changes.length) io.out(`Séance is already set up in ${repo}. Nothing changed.`);
        else io.out(`Séance set up in ${repo}:\n${changes.map((c) => `  - ${c}`).join("\n")}`);
        return 0;
      }
      case "whois":
        return await whoisCommand(args, cwd, io);
      case "ask":
        return await askCommand(args, { config: ctx.config ?? getConfig(), cwd, io, timeoutMs: ctx.askTimeoutMs });
      case "ls": {
        const config = ctx.config ?? getConfig();
        const registry = await (ctx.getRegistry ?? defaultRegistry)(config);
        io.out(formatSessions(await registry.listSessions()));
        return 0;
      }
      case "snapshot": {
        const config = ctx.config ?? getConfig();
        const registry = await (ctx.getRegistry ?? defaultRegistry)(config);
        return await snapshotCommand(args, registry, io, (ctx.now ?? (() => new Date()))());
      }
      case "migrate": {
        const { migrateCommand } = await import("./migrate.ts");
        return await migrateCommand(args, { config: ctx.config ?? getConfig(), io });
      }
      default:
        io.err(`seance: unknown command "${cmd}"\n\n${USAGE}`);
        return 1;
    }
  } catch (e) {
    io.err(`Séance: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
