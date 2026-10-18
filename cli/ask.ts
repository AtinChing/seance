import { SEANCE_ROOT, type SeanceConfig } from "../config/index.ts";
import { shortIdFromAddress } from "../shared/address.ts";
import { SECRET_HEADER, type AskRequest, type AskResponse } from "../shared/api.ts";
import { whoisLine } from "../shared/git.ts";
import { writeAskedMarker } from "../hooks/common.ts";
import { parseAddressArg, parseFileLine, resolveFileLine } from "./target.ts";
import type { Io } from "./io.ts";

export const ASK_TIMEOUT_MS = 125_000;

export interface AskOptions {
  config: SeanceConfig;
  cwd: string;
  io: Io;
  timeoutMs?: number;
}

const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);

function errCode(e: unknown): string | undefined {
  const any = e as { code?: string; cause?: { code?: string; errors?: Array<{ code?: string }> } };
  return any?.cause?.code ?? any?.cause?.errors?.[0]?.code ?? any?.code;
}

export function formatAnswer(r: Extract<AskResponse, { ok: true }>, fallbackCommit?: string): string {
  const lines: string[] = [];
  if (r.blocked) {
    lines.push(r.answer.trim());
    lines.push("");
    lines.push(`(The answer was held back by Séance's outbound filter${r.blockedReason ? `: ${r.blockedReason}` : ""}.)`);
  } else {
    lines.push(r.answer.trim());
  }
  lines.push("");
  lines.push("Evidence:");
  if (!r.quotes?.length) lines.push("  (no quotes)");
  for (const q of r.quotes ?? []) lines.push(q.verified ? `  ✓ "${q.text}"` : `  ? "${q.text}" (unverified)`);
  lines.push("");
  const parts = [`Session s-${r.shortId}`];
  const commit = r.commit ?? fallbackCommit;
  if (commit) parts.push(`commit ${commit.slice(0, 7)}`);
  parts.push(`answered in ${Math.round((r.durationMs ?? 0) / 1000)}s`);
  lines.push(parts.join(" · "));
  return lines.join("\n");
}

/** `seance ask <file>:<line>|<address> "<question>"`. Returns the exit code. */
export async function askCommand(args: string[], opts: AskOptions): Promise<number> {
  const { config, io } = opts;
  const [target, ...rest] = args;
  const question = rest.join(" ").trim();
  if (!target || !question) {
    io.err('usage: seance ask <file>:<line> "<question>"   or   seance ask <s-xxxxxxxx@domain> "<question>"');
    return 1;
  }

  const req: AskRequest = { question, timeoutMs: 120_000 };
  let marker: { repo: string; rel: string } | null = null;
  let localCommit: string | undefined;
  const addr = parseAddressArg(target, config.primitiveDomain);
  if (addr) {
    req.address = addr;
  } else if (parseFileLine(target)) {
    let fl;
    try {
      fl = await resolveFileLine(opts.cwd, target);
    } catch (e) {
      io.err(`Séance: ${(e as Error).message}`);
      return 1;
    }
    let who;
    try {
      who = await whoisLine(fl.repo, fl.rel, fl.line);
    } catch (e) {
      io.err(`Séance: could not blame ${fl.rel}:${fl.line} (${(e as Error).message.split("\n")[0]})`);
      return 1;
    }
    if (!who.address || !who.shortId) {
      const what = who.subject === "(uncommitted)" ? "is not committed yet" : `was last changed in commit ${who.sha.slice(0, 7)}, which has no Agent-Session trailer`;
      io.err(`Séance: ${fl.rel}:${fl.line} ${what}, so there is no session to ask.`);
      return 1;
    }
    Object.assign(req, { address: who.address, repo: fl.repo, file: fl.rel, line: fl.line });
    marker = { repo: fl.repo, rel: fl.rel };
    localCommit = who.sha;
  } else {
    io.err(`Séance: "${target}" is neither <file>:<line> nor a session address like s-xxxxxxxx@domain.`);
    return 1;
  }

  if (!config.seanceSecret) {
    io.err(`Séance: SEANCE_SECRET is not set (add it to ${SEANCE_ROOT}/.env).`);
    return 1;
  }

  const url = `${config.serverUrl}/api/ask`;
  const timeoutMs = opts.timeoutMs ?? ASK_TIMEOUT_MS;
  io.err(`Asking ${req.address} (a disposable fork of that session is waking up, ~30–90 s)…`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  let body: AskResponse;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", [SECRET_HEADER]: config.seanceSecret },
      body: JSON.stringify(req),
      signal: ac.signal,
    });
    const text = await res.text();
    try {
      body = JSON.parse(text) as AskResponse;
    } catch {
      io.err(`Séance: the server at ${config.serverUrl} returned HTTP ${res.status} with a non-JSON body.`);
      return 1;
    }
  } catch (e) {
    if (ac.signal.aborted) {
      io.err(`Séance: timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${req.address} to answer. The ghost may still reply by email; try again later.`);
      return 1;
    }
    if (UNREACHABLE.has(errCode(e) ?? "")) {
      io.err(`Séance server is not running at ${config.serverUrl}. Start it with: npm run server (in ${SEANCE_ROOT})`);
      return 1;
    }
    io.err(`Séance: request to ${url} failed: ${(e as Error).message}`);
    return 1;
  } finally {
    clearTimeout(timer);
  }

  if (!body || typeof body !== "object" || !("ok" in body)) {
    io.err(`Séance: unexpected response from ${url} (HTTP ${res.status}).`);
    return 1;
  }
  if (!body.ok) {
    const hint = body.code === "unauthorized" ? " Check that SEANCE_SECRET matches the server's." : "";
    io.err(`Séance: ${body.code}: ${body.error}${hint}`);
    return 1;
  }

  io.out(formatAnswer(body, localCommit));
  if (marker) {
    const sid = body.shortId || shortIdFromAddress(req.address!) || "";
    if (sid) writeAskedMarker(marker.repo, sid, marker.rel, { question, questionId: body.questionId });
  }
  return 0;
}
