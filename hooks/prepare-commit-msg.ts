import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { addressFor, shortIdFor } from "../shared/address.ts";
import { repoRoot, TRAILER_KEY } from "../shared/git.ts";
import { logHook, readCurrentSession, type HookContext, type HookResult } from "./common.ts";

const run = promisify(execFile);

/** Should this commit be stamped? Only commits made from Claude Code's Bash tool (CLAUDECODE=1). */
export function shouldStamp(env: Record<string, string | undefined>): boolean {
  return env.CLAUDECODE === "1" || env.SEANCE_STAMP_ALWAYS === "1";
}

/**
 * Git prepare-commit-msg (args: msgFile, source, sha). Adds the Agent-Session and Co-Authored-By
 * trailers when a Claude Code session is current in this repo. The human stays the author.
 * `addIfDifferent` keeps amends from duplicating trailers.
 */
export async function prepareCommitMsg(args: string[], ctx: HookContext): Promise<HookResult> {
  const [msgFile] = args;
  if (!msgFile) throw new Error("prepare-commit-msg: missing message file argument");
  if (!shouldStamp(ctx.env)) return { code: 0 };
  const repo = (await repoRoot(ctx.cwd)) ?? ctx.cwd;
  const sessionId = readCurrentSession(repo);
  if (!sessionId) return { code: 0 };
  if (!ctx.config.primitiveDomain) throw new Error("prepare-commit-msg: PRIMITIVE_DOMAIN is not configured");

  const shortId = shortIdFor(sessionId);
  const address = addressFor(shortId, ctx.config.primitiveDomain);
  const file = path.resolve(ctx.cwd, msgFile);
  await run("git", [
    "-C", repo,
    "interpret-trailers", "--in-place", "--if-exists", "addIfDifferent",
    "--trailer", `${TRAILER_KEY}: ${address}`,
    "--trailer", `Co-Authored-By: Claude session ${shortId} <${address}>`,
    file,
  ]);
  logHook(ctx.config.dataDir, "prepare-commit-msg", `stamped ${address} in ${repo}`);
  return { code: 0 };
}
