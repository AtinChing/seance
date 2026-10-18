import fs from "node:fs";
import path from "node:path";
import { addressFor, isGhostAddress } from "../shared/address.ts";
import { repoRoot } from "../shared/git.ts";
import { normalizeRel, realpathOr } from "../hooks/common.ts";

export interface FileLine {
  repo: string;   // absolute repo root
  rel: string;    // repo-relative, forward slashes
  line: number;
}

/** "src/x.ts:12" -> { file, line } or null. */
export function parseFileLine(arg: string): { file: string; line: number } | null {
  const m = arg.match(/^(.+):(\d+)$/);
  if (!m) return null;
  const line = Number(m[2]);
  return line >= 1 ? { file: m[1], line } : null;
}

/** Resolves a cwd-relative (or absolute) file:line to its repo and repo-relative path. */
export async function resolveFileLine(cwd: string, arg: string): Promise<FileLine> {
  const p = parseFileLine(arg);
  if (!p) throw new Error(`expected <file>:<line>, got "${arg}"`);
  const abs = path.resolve(cwd, p.file);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${p.file}`);
  const real = realpathOr(abs);
  const repo = await repoRoot(path.dirname(real));
  if (!repo) throw new Error(`${p.file} is not inside a git repository`);
  const rel = normalizeRel(path.relative(realpathOr(repo), real));
  return { repo, rel, line: p.line };
}

/** Accepts `s-xxxxxxxx@domain` or bare `s-xxxxxxxx`. Returns the full address or null. */
export function parseAddressArg(arg: string, domain: string): string | null {
  if (/^s-[0-9a-f]{8}$/i.test(arg)) return addressFor(arg.slice(2), domain);
  if (arg.includes("@") && isGhostAddress(arg)) return arg.trim();
  return null;
}
