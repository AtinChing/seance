// Routes the MCP server (mcp/) needs besides /api/ask: list sessions and whois a line.
// Both require the x-seance-secret header. Wired into the app by server/app.ts's owner:
//   registerMcpSupportRoutes(app, { config, registry })
import path from "node:path";
import type { Hono } from "hono";
import type { SeanceConfig } from "../config/index.ts";
import { SECRET_HEADER } from "../shared/api.ts";
import { whoisLine, type WhoisResult } from "../shared/git.ts";
import type { Registry } from "../shared/interfaces.ts";
import { safeEqual } from "./inbound.ts";

export interface McpSupportDeps {
  config: SeanceConfig;
  registry: Registry;
  /** file:line -> session (defaults to shared/git whoisLine). */
  whois?: (repo: string, file: string, line: number) => Promise<WhoisResult>;
}

/** One row of GET /api/sessions. Only the repo's folder name leaves the server, never its full path. */
export interface SessionSummary {
  shortId: string;
  address: string;
  repo: string;
  startedAt: string;
  endedAt?: string;
  hasSnapshot: boolean;
}

export type SessionsResponse = { ok: true; sessions: SessionSummary[] } | McpSupportError;

export interface WhoisRequest {
  repo?: string;   // absolute repo path; when omitted, every repo a registered session worked in is tried, newest first
  file: string;    // repo-relative
  line: number;    // 1-based
}

export type WhoisResponse = ({ ok: true; repo: string } & WhoisResult) | McpSupportError;

export type McpSupportErrorCode = "bad_request" | "unauthorized" | "no_session_for_line" | "internal";
export interface McpSupportError { ok: false; code: McpSupportErrorCode; error: string }

const STATUS: Record<McpSupportErrorCode, 400 | 401 | 404 | 500> = {
  bad_request: 400, unauthorized: 401, no_session_for_line: 404, internal: 500,
};

function fail(code: McpSupportErrorCode, error: string): Response {
  return new Response(JSON.stringify({ ok: false, code, error } satisfies McpSupportError), {
    status: STATUS[code],
    headers: { "content-type": "application/json" },
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerMcpSupportRoutes(app: Hono<any>, deps: McpSupportDeps): void {
  const { config, registry } = deps;
  const whois = deps.whois ?? whoisLine;
  const authorized = (header: string | undefined) => safeEqual(header, config.seanceSecret);

  const newestFirst = async () =>
    [...(await registry.listSessions())].sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));

  app.get("/api/sessions", async (c) => {
    if (!authorized(c.req.header(SECRET_HEADER))) return fail("unauthorized", "Missing or wrong x-seance-secret.");
    try {
      const sessions: SessionSummary[] = (await newestFirst()).map((s) => ({
        shortId: s.shortId,
        address: s.address,
        repo: path.basename(s.repoPath || ""),
        startedAt: s.startedAt,
        ...(s.endedAt ? { endedAt: s.endedAt } : {}),
        hasSnapshot: Boolean(s.transcriptSnapshot),
      }));
      return c.json({ ok: true, sessions } satisfies SessionsResponse);
    } catch (err) {
      return fail("internal", `Could not list sessions: ${errMessage(err)}`);
    }
  });

  app.post("/api/whois", async (c) => {
    if (!authorized(c.req.header(SECRET_HEADER))) return fail("unauthorized", "Missing or wrong x-seance-secret.");
    let body: Partial<WhoisRequest>;
    try {
      body = (await c.req.json()) as Partial<WhoisRequest>;
    } catch {
      return fail("bad_request", "Body must be JSON.");
    }
    const file = typeof body?.file === "string" ? body.file.trim() : "";
    const line = body?.line;
    if (!file) return fail("bad_request", "`file` is required (repo-relative path).");
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return fail("bad_request", "`line` must be a positive integer (1-based).");
    if (body.repo !== undefined && (typeof body.repo !== "string" || !path.isAbsolute(body.repo))) {
      return fail("bad_request", "`repo` must be an absolute path when given.");
    }

    const candidates = body.repo
      ? [body.repo]
      : [...new Set((await newestFirst().catch(() => [])).map((s) => s.repoPath).filter(Boolean))];
    if (!candidates.length) return fail("no_session_for_line", "No repo given and no registered sessions to search.");

    let firstBlamed: { repo: string; result: WhoisResult } | null = null;
    const errors: string[] = [];
    for (const repo of candidates) {
      try {
        const result = await whois(repo, file, line);
        if (result.address) return c.json({ ok: true, repo: path.basename(repo), ...result } satisfies WhoisResponse);
        firstBlamed ??= { repo, result };
      } catch (err) {
        errors.push(errMessage(err).split(repo).join(path.basename(repo)));
      }
    }
    // Blamed, but no Agent-Session trailer: a human (or an unrecorded session) wrote it.
    if (firstBlamed) return c.json({ ok: true, repo: path.basename(firstBlamed.repo), ...firstBlamed.result } satisfies WhoisResponse);
    const where = body.repo ? `in ${path.basename(body.repo)}` : `in any of ${candidates.length} known repo(s)`;
    return fail("no_session_for_line", `Could not blame ${file}:${line} ${where}${errors[0] ? `: ${errors[0].trim().split("\n").pop()}` : ""}`);
  });
}
