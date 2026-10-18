import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SEANCE_ROOT, type SeanceConfig } from "../config/index.ts";
import type { Registry } from "../shared/interfaces.ts";

/** Fields Claude Code puts on hook stdin (confirmed in M0, see STATUS.md). */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;                 // SessionStart: startup | resume | clear | compact
  reason?: string;                 // SessionEnd
  tool_name?: string;              // PreToolUse
  tool_input?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface HookResult {
  code: number;                    // 0 = allow / ok, 2 = block (PreToolUse)
  stderr?: string;
}

/** Everything a hook needs from the outside world, injectable for tests. */
export interface HookContext {
  config: SeanceConfig;
  env: Record<string, string | undefined>;
  cwd: string;
  getRegistry: () => Promise<Registry>;
  now?: () => Date;
}

/** Absolute command prefix used in hooks so they work without `seance` on PATH. */
export const CLI_COMMAND = `node "${path.join(SEANCE_ROOT, "cli", "bin.js")}"`;

export const ASKED_MARKER_TTL_MS = 30 * 60 * 1000;

/** Per-repo state dir: `<repo>/.seance`. */
export function repoStateDir(repo: string): string {
  return path.join(repo, ".seance");
}

export function currentSessionFile(repo: string): string {
  return path.join(repoStateDir(repo), "current-session");
}

export function readCurrentSession(repo: string): string | null {
  try {
    const id = fs.readFileSync(currentSessionFile(repo), "utf8").trim();
    return id || null;
  } catch {
    return null;
  }
}

/** Repo-relative path with forward slashes, the canonical form used for asked-markers. */
export function normalizeRel(rel: string): string {
  return rel.split(path.sep).join("/").replace(/^\.\//, "");
}

/** `<first 12 hex of sha1(repo-relative path)>` */
export function fileKey(relFile: string): string {
  return createHash("sha1").update(normalizeRel(relFile)).digest("hex").slice(0, 12);
}

export function askedMarkerPath(repo: string, shortId: string, relFile: string): string {
  return path.join(repoStateDir(repo), "asked", `${shortId.toLowerCase()}__${fileKey(relFile)}`);
}

export function writeAskedMarker(repo: string, shortId: string, relFile: string, info: Record<string, unknown> = {}): string {
  const p = askedMarkerPath(repo, shortId, relFile);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ shortId, file: normalizeRel(relFile), askedAt: new Date().toISOString(), ...info }) + "\n");
  return p;
}

/** True if a marker for shortId+file exists and is younger than the TTL. */
export function hasFreshAskedMarker(repo: string, shortId: string, relFile: string, now: Date = new Date()): boolean {
  try {
    const st = fs.statSync(askedMarkerPath(repo, shortId, relFile));
    return now.getTime() - st.mtimeMs < ASKED_MARKER_TTL_MS;
  } catch {
    return false;
  }
}

/** Resolves symlinks (macOS /var -> /private/var) when the path exists. */
export function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Appends one line to `<dataDir>/hooks.log`. Never throws. Never pass secrets or file contents here. */
export function logHook(dataDir: string | undefined, hook: string, message: string): void {
  try {
    const dir = dataDir || path.join(SEANCE_ROOT, ".seance");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "hooks.log"), `${new Date().toISOString()} [${hook}] ${message.replace(/\s*\n\s*/g, " | ")}\n`);
  } catch {
    /* logging must never break a hook */
  }
}

export function parseHookInput(text: string): HookInput {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty hook stdin");
  const v = JSON.parse(trimmed);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("hook stdin is not a JSON object");
  return v as HookInput;
}
