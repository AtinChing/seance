// HTTP client for the Séance server plus text rendering for tool results.
// No mcp-use imports here so it can be unit-tested from the root vitest run.
//
// The wire types mirror shared/api.ts and server/mcp-support.ts in the Séance repo. They are copied,
// not imported, because `mcp-use deploy` uploads only this folder.

export const SECRET_HEADER = "x-seance-secret";
export const ASK_TIMEOUT_MS = 130_000;      // client side; the server gives up at 120 s
export const SERVER_ASK_TIMEOUT_MS = 120_000;
const QUICK_TIMEOUT_MS = 20_000;

export interface Quote { text: string; verified: boolean }

export type AskErrorCode = "bad_request" | "unauthorized" | "unknown_session" | "no_session_for_line" | "timeout" | "internal";

export interface AskRequest {
  address?: string;
  repo?: string;
  file?: string;
  line?: number;
  question: string;
  timeoutMs?: number;
}

export interface AskOk {
  ok: true;
  questionId: string;
  address: string;
  shortId: string;
  answer: string;
  quotes: Quote[];
  confidence: "high" | "medium" | "low";
  runner: "local" | "blaxel";
  durationMs: number;
  commit?: string;
  blocked: boolean;
  blockedReason?: string;
  via: "email" | "in-process";
}

export interface WhoisOk {
  ok: true;
  repo: string;            // folder name only
  file: string;
  line: number;
  sha: string;
  date: string;
  subject: string;
  address: string | null;
  shortId: string | null;
}

export interface SessionSummary {
  shortId: string;
  address: string;
  repo: string;
  startedAt: string;
  endedAt?: string;
  hasSnapshot: boolean;
}

/** Every failure the tools can report, with a message written for the calling agent. */
export type SeanceErrorCode = AskErrorCode | "blocked" | "unreachable" | "not_supported";

export class SeanceError extends Error {
  constructor(public code: SeanceErrorCode, message: string) {
    super(message);
  }
}

export interface SeanceClientOptions {
  serverUrl: string;
  secret?: string;
  fetch?: typeof fetch;
}

/** Accepts a full address, "s-<8hex>", or a bare 8-hex short id. */
export function normalizeAddress(input: string): string {
  const s = input.trim();
  return /^[0-9a-f]{8}$/i.test(s) ? `s-${s.toLowerCase()}` : s;
}

const HINT_FOR: Record<SeanceErrorCode, string> = {
  bad_request: "Check the arguments: pass `address`, or `file` + `line` (plus `repo` if the server can't find the file), and a non-empty `question`.",
  unauthorized: "The Séance server rejected this MCP server's secret. Set SEANCE_SECRET in the MCP server's environment to the same value as the Séance server's SEANCE_SECRET.",
  unknown_session: "No session with that address is registered. Call list_sessions to see valid addresses, or whois_line to find which session wrote a line.",
  no_session_for_line: "That line isn't attributed to a recorded Claude Code session (it may be uncommitted, written by a human, or the path/repo is wrong). There's no ghost to ask; proceed with normal care, or check the file path and pass `repo` (absolute path).",
  timeout: "The ghost didn't answer in time. It may still be thinking: retry once, or email the session address directly and check back later.",
  blocked: "Séance's outbound filter withheld the ghost's reply because it looked like it contained a secret. Rephrase the question so it doesn't ask for keys, env vars or file contents.",
  internal: "The Séance server hit an internal error. Retrying once is reasonable.",
  unreachable: "The Séance server could not be reached. Check that it is running and that SEANCE_SERVER_URL points at it (for a deployed MCP server, the public tunnel URL).",
  not_supported: "This Séance server is older than the MCP server and lacks that endpoint. Restart it with the latest code.",
};

export function errorText(err: SeanceError): string {
  return `Séance error (${err.code}): ${err.message}\n${HINT_FOR[err.code]}`;
}

export class SeanceClient {
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly opts: SeanceClientOptions) {
    this.base = opts.serverUrl.replace(/\/+$/, "");
    this.f = opts.fetch ?? fetch;
  }

  private async call<T extends { ok: true }>(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (!this.opts.secret) throw new SeanceError("unauthorized", "SEANCE_SECRET is not set in the MCP server's environment.");
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: { [SECRET_HEADER]: this.opts.secret, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: combined,
      });
    } catch (err) {
      if (timeout.aborted) throw new SeanceError("timeout", `No response from the Séance server within ${Math.round(timeoutMs / 1000)} s.`);
      if (signal?.aborted) throw new SeanceError("internal", "The request was cancelled by the client.");
      throw new SeanceError("unreachable", `Could not reach ${this.base}${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const raw = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      data = undefined;
    }
    const obj = data as { ok?: boolean; code?: string; error?: string } | undefined;
    if (obj && obj.ok === true && res.ok) return obj as T;
    if (obj && obj.ok === false) {
      const code = (Object.keys(HINT_FOR).includes(obj.code ?? "") ? obj.code : "internal") as SeanceErrorCode;
      throw new SeanceError(code, obj.error || `HTTP ${res.status}`);
    }
    if (res.status === 404) throw new SeanceError("not_supported", `${method} ${path} returned 404.`);
    if (res.status === 401) throw new SeanceError("unauthorized", "HTTP 401.");
    if (res.status === 502 || res.status === 503 || res.status === 504 || res.status === 524 || res.status === 530) {
      throw new SeanceError(res.status === 524 ? "timeout" : "unreachable", `HTTP ${res.status} from ${this.base} (tunnel or proxy error).`);
    }
    throw new SeanceError("internal", `Unexpected HTTP ${res.status} from ${path}.`);
  }

  ask(req: AskRequest, signal?: AbortSignal): Promise<AskOk> {
    return this.call<AskOk>("POST", "/api/ask", { timeoutMs: SERVER_ASK_TIMEOUT_MS, ...req }, ASK_TIMEOUT_MS, signal);
  }

  whois(req: { file: string; line: number; repo?: string }, signal?: AbortSignal): Promise<WhoisOk> {
    return this.call<WhoisOk>("POST", "/api/whois", req, QUICK_TIMEOUT_MS, signal);
  }

  async sessions(signal?: AbortSignal): Promise<SessionSummary[]> {
    return (await this.call<{ ok: true; sessions: SessionSummary[] }>("GET", "/api/sessions", undefined, QUICK_TIMEOUT_MS, signal)).sessions;
  }
}

// ---- rendering ----------------------------------------------------------------

const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;

export function renderAnswer(r: AskOk): string {
  const lines = [
    `Answer from session s-${r.shortId} (${r.address})`,
    `commit ${r.commit ? r.commit.slice(0, 7) : "unknown"} · ${secs(r.durationMs)} · confidence ${r.confidence} · via ${r.via}`,
    "",
    r.answer.trim(),
  ];
  if (r.quotes.length) {
    const verified = r.quotes.filter((q) => q.verified).length;
    lines.push("", `Evidence quotes from the session's own transcript (${verified}/${r.quotes.length} verified):`);
    for (const q of r.quotes) {
      lines.push(q.verified ? `✓ VERIFIED  "${q.text}"` : `? UNVERIFIED "${q.text}" (not found in the transcript; do not treat as proof)`);
    }
  } else {
    lines.push("", "No evidence quotes were given; treat the answer as the ghost's recollection, not proof.");
  }
  return lines.join("\n");
}

export function renderWhois(w: WhoisOk): string {
  const at = `${w.file}:${w.line}`;
  if (/^0+$/.test(w.sha)) return `${at} is uncommitted, so no session is recorded for it.`;
  const commit = `commit ${w.sha.slice(0, 7)} "${w.subject}"${w.date ? ` (${w.date})` : ""} in ${w.repo}`;
  if (!w.address) return `${at} comes from ${commit}, which has no Agent-Session trailer: a human or an unrecorded session wrote it. There's no ghost to ask.`;
  return `${at} was written by Claude Code session s-${w.shortId} (${w.address}), ${commit}.\nAsk it why with ask_session({ address: "${w.address}", question: "..." }).`;
}

export function renderSessions(list: SessionSummary[]): string {
  if (!list.length) return "No Séance sessions are registered yet.";
  const rows = list.map((s) => {
    const state = s.endedAt ? `ended ${s.endedAt}` : "running or not ended";
    return `- ${s.address}  repo ${s.repo || "?"}  started ${s.startedAt}  ${state}  snapshot ${s.hasSnapshot ? "yes" : "no"}`;
  });
  return [`${list.length} session(s), newest first:`, ...rows].join("\n");
}
