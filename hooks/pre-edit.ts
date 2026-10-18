import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { shortIdFor, shortIdFromAddress } from "../shared/address.ts";
import { blameRange, repoRoot, sessionAddressForCommit } from "../shared/git.ts";
import { hasFreshAskedMarker, logHook, normalizeRel, realpathOr, type HookContext, type HookInput, type HookResult } from "./common.ts";

const run = promisify(execFile);

type Range = [number, number]; // inclusive, 1-based

function countNewlines(s: string, from = 0, to = s.length): number {
  let n = 0;
  for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

export function lineCount(content: string): number {
  if (!content) return 0;
  const n = countNewlines(content);
  return content.endsWith("\n") ? n : n + 1;
}

/** Line ranges in `content` covered by `needle` (first occurrence, or all of them). */
export function rangesForOldString(content: string, needle: string, all: boolean): Range[] {
  if (!needle) return [];
  const ranges: Range[] = [];
  let span = countNewlines(needle);
  if (needle.endsWith("\n") && span > 0) span -= 1;
  let from = 0;
  while (from <= content.length) {
    const idx = content.indexOf(needle, from);
    if (idx === -1) break;
    const start = countNewlines(content, 0, idx) + 1;
    ranges.push([start, start + span]);
    if (!all) break;
    from = idx + needle.length;
  }
  return ranges;
}

/** Which lines of the current file does this tool call touch? Empty = nothing to check. */
export function touchedRanges(toolName: string, toolInput: Record<string, unknown>, content: string): Range[] {
  const total = lineCount(content);
  let ranges: Range[] = [];
  if (toolName === "Edit") {
    ranges = rangesForOldString(content, String(toolInput.old_string ?? ""), toolInput.replace_all === true);
  } else if (toolName === "MultiEdit") {
    const edits = Array.isArray(toolInput.edits) ? (toolInput.edits as Record<string, unknown>[]) : [];
    for (const e of edits) {
      // Later edits may target text produced by earlier ones; those simply are not found here.
      ranges.push(...rangesForOldString(content, String(e?.old_string ?? ""), e?.replace_all === true));
    }
  } else if (toolName === "Write") {
    if (total > 0) ranges = [[1, total]];
  }
  return mergeRanges(ranges.map(([s, e]) => [Math.max(1, s), Math.min(total, e)] as Range).filter(([s, e]) => s <= e));
}

export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

async function isTracked(repo: string, rel: string): Promise<boolean> {
  try {
    await run("git", ["-C", repo, "ls-files", "--error-unmatch", "--", rel]);
    return true;
  } catch {
    return false;
  }
}

export function blockMessage(rel: string, address: string, shortId: string, first: number, last: number): string {
  return [
    `Séance: lines ${first}-${last} of ${rel} were written by session s-${shortId} (${address}).`,
    `That session may know why this code is the way it is. Before changing it, run:`,
    `  seance ask ${rel}:${first} "<your question about why it is this way>"`,
    `Then retry your edit.`,
  ].join("\n");
}

/** PreToolUse (Edit|MultiEdit|Write): block edits to lines another session wrote until someone asks it. */
export async function preEdit(input: HookInput, ctx: HookContext): Promise<HookResult> {
  const toolName = String(input.tool_name ?? "");
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  if (!["Edit", "MultiEdit", "Write"].includes(toolName)) return { code: 0 };
  const rawPath = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
  if (!rawPath) return { code: 0 };
  const abs = path.resolve(input.cwd || ctx.cwd, rawPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { code: 0 }; // new file

  const real = realpathOr(abs);
  const repo = await repoRoot(path.dirname(real));
  if (!repo) return { code: 0 };
  const rel = normalizeRel(path.relative(realpathOr(repo), real));
  if (!rel || rel.startsWith("..")) return { code: 0 };
  if (!(await isTracked(repo, rel))) return { code: 0 };

  const content = fs.readFileSync(real, "utf8");
  const ranges = touchedRanges(toolName, toolInput, content);
  if (!ranges.length) return { code: 0 };

  const own = input.session_id ? shortIdFor(input.session_id) : null;
  const shaCache = new Map<string, string | null>();
  const bySession = new Map<string, { address: string; lines: number[] }>();
  for (const [s, e] of ranges) {
    for (const b of await blameRange(repo, rel, s, e)) {
      if (!b.committed) continue;
      if (!shaCache.has(b.sha)) shaCache.set(b.sha, await sessionAddressForCommit(repo, b.sha));
      const address = shaCache.get(b.sha);
      if (!address) continue;
      const sid = shortIdFromAddress(address);
      if (!sid || sid === own) continue;
      const entry = bySession.get(sid) ?? { address, lines: [] };
      entry.lines.push(b.line);
      bySession.set(sid, entry);
    }
  }

  const now = (ctx.now ?? (() => new Date()))();
  const messages: string[] = [];
  for (const [sid, { address, lines }] of bySession) {
    if (hasFreshAskedMarker(repo, sid, rel, now)) continue;
    messages.push(blockMessage(rel, address, sid, Math.min(...lines), Math.max(...lines)));
  }
  if (!messages.length) return { code: 0 };
  logHook(ctx.config.dataDir, "pre-edit", `blocked ${toolName} on ${rel} (sessions: ${[...bySession.keys()].join(",")})`);
  return { code: 2, stderr: messages.join("\n\n") + "\n" };
}
