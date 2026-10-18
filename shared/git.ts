import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shortIdFromAddress } from "./address.ts";

const run = promisify(execFile);

export const TRAILER_KEY = "Agent-Session";

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export interface BlamedLine {
  line: number;          // 1-based line number in the current file
  sha: string;           // 40-hex commit, or 0000… for uncommitted lines
  committed: boolean;
}

/** git blame for an inclusive 1-based line range of a repo-relative (or absolute) file. */
export async function blameRange(repo: string, file: string, start: number, end: number): Promise<BlamedLine[]> {
  const out = await git(repo, ["blame", "--porcelain", "-L", `${start},${end}`, "--", file]);
  const lines: BlamedLine[] = [];
  for (const row of out.split("\n")) {
    const m = row.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (m) lines.push({ sha: m[1], line: Number(m[2]), committed: !/^0+$/.test(m[1]) });
  }
  return lines;
}

/** The Agent-Session trailer address on a commit, or null. */
export async function sessionAddressForCommit(repo: string, sha: string): Promise<string | null> {
  if (/^0+$/.test(sha)) return null;
  const out = await git(repo, ["log", "-1", `--format=%(trailers:key=${TRAILER_KEY},valueonly)`, sha]);
  const first = out.split("\n").map((s) => s.trim()).find(Boolean);
  return first ?? null;
}

export interface WhoisResult {
  file: string;
  line: number;
  sha: string;
  date: string;          // ISO commit date
  subject: string;
  address: string | null;
  shortId: string | null;
}

/** Who wrote file:line? Resolves blame -> commit -> Agent-Session trailer. */
export async function whoisLine(repo: string, file: string, line: number): Promise<WhoisResult> {
  const [b] = await blameRange(repo, file, line, line);
  if (!b) throw new Error(`no blame for ${file}:${line}`);
  if (!b.committed) return { file, line, sha: b.sha, date: "", subject: "(uncommitted)", address: null, shortId: null };
  const meta = await git(repo, ["log", "-1", "--format=%cI%x00%s", b.sha]);
  const [date, subject] = meta.trim().split("\0");
  const address = await sessionAddressForCommit(repo, b.sha);
  return { file, line, sha: b.sha, date, subject, address, shortId: address ? shortIdFromAddress(address) : null };
}

/** Most recent commit (any branch) whose Agent-Session trailer names this short id, or null. */
export async function lastCommitForSession(repo: string, shortId: string): Promise<string | null> {
  const out = await git(repo, ["log", "--all", `--format=%H%x00%(trailers:key=${TRAILER_KEY},valueonly,separator=%x2C)`]);
  for (const row of out.split("\n")) {
    const [sha, trailers] = row.split("\0");
    if (!sha || !trailers) continue;
    if (trailers.split(",").some((t) => shortIdFromAddress(t.trim()) === shortId.toLowerCase())) return sha;
  }
  return null;
}

/** Absolute path of the repo's top level containing `dir`, or null if not in a git repo. */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
}
