import { timingSafeEqual, createHash } from "node:crypto";
import { MCPServer } from "mcp-use";
import { z } from "zod";
import { loadMcpConfig } from "./src/config.js";
import {
  ASK_TIMEOUT_MS, errorText, normalizeAddress, renderAnswer, renderSessions, renderWhois,
  SeanceClient, SeanceError, type AskRequest,
} from "./src/seance.js";

const config = loadMcpConfig();
const seance = new SeanceClient({ serverUrl: config.serverUrl, secret: config.secret });

const server = new MCPServer({
  name: "seance",
  title: "Séance",
  version: "1.0.0",
  description: "Ask the Claude Code session that wrote a line of code why it is the way it is. Email a dead agent. It answers.",
  instructions:
    "Séance gives every Claude Code session an email address, stamped into its commits as an Agent-Session trailer. " +
    "Before changing code that another Claude Code session wrote, when the reason for it isn't obvious (magic numbers, odd orderings, " +
    "deliberate-looking workarounds), or when a Séance hook blocked your edit, call whois_line and then ask_session to ask that session why. " +
    "A read-only fork of the original session answers from its own transcript, with quotes Séance checks against the real transcript.",
  icons: [{ src: "icon.svg", mimeType: "image/svg+xml" }],
});

// Optional shared-token gate for the MCP endpoint (recommended when deployed: the tools can wake paid ghosts).
if (config.accessToken) {
  const want = createHash("sha256").update(config.accessToken).digest();
  server.use(async (c, next) => {
    if (c.req.path === "/mcp") {
      const got = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!got || !timingSafeEqual(createHash("sha256").update(got).digest(), want)) {
        return c.json({ error: "unauthorized: send Authorization: Bearer <SEANCE_MCP_TOKEN>" }, 401);
      }
    }
    await next();
  });
}

const fail = (err: unknown) => {
  const e = err instanceof SeanceError ? err : new SeanceError("internal", err instanceof Error ? err.message : String(err));
  return { isError: true as const, content: [{ type: "text" as const, text: errorText(e) }] };
};

const quoteSchema = z.object({
  text: z.string(),
  verified: z.boolean().describe("true only if this text appears verbatim in the original session transcript"),
});

const askOutput = z.object({
  address: z.string(),
  shortId: z.string(),
  answer: z.string(),
  quotes: z.array(quoteSchema),
  confidence: z.enum(["high", "medium", "low"]),
  commit: z.string().optional(),
  durationMs: z.number(),
  blocked: z.boolean(),
  via: z.enum(["email", "in-process"]),
  questionId: z.string(),
});

export const askSession = server.tool(
  {
    name: "ask_session",
    title: "Ask the session that wrote this code",
    description:
      "Ask the Claude Code session that wrote some code why it did something, and get its answer with evidence quotes from its own transcript. " +
      "Use this BEFORE changing code another Claude Code session wrote when the reason isn't obvious from the code (magic numbers, " +
      "odd choices, things that look like they could be simplified), and whenever a Séance hook blocked your edit. " +
      "Identify the session by `address` (from whois_line, list_sessions, a commit's Agent-Session trailer, or a hook message), or by " +
      "`file` + `line` (repo-relative; add `repo` as an absolute path if the server can't find the file). " +
      "Quotes marked verified were found verbatim in the original transcript; unverified ones are not proof. " +
      "Slow: a disposable fork of the session wakes up and answers by email, typically 30-90 s. Each call costs real money, so ask one clear, specific question.",
    inputSchema: z.object({
      address: z.string().optional().describe("Session address like s-055fcb2d@safe-maple.primitive.email, or just s-055fcb2d"),
      file: z.string().optional().describe("Repo-relative path of the code you're asking about, e.g. src/retry.ts"),
      line: z.number().int().positive().optional().describe("1-based line number in `file`"),
      repo: z.string().optional().describe("Absolute path of the git repo on the Séance server's machine. Optional; only needed with file+line when the server can't find the file in a known repo"),
      question: z.string().min(1).describe("One specific question, e.g. 'Why is RETRY_BASE_DELAY 0.37? Did you try smaller values?'"),
    }),
    outputSchema: askOutput,
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
  },
  async ({ address, file, line, repo, question }, ctx) => {
    const req: AskRequest = { question };
    const hasLine = Boolean(file) && typeof line === "number";
    try {
      if (address) {
        req.address = normalizeAddress(address);
        if (hasLine) Object.assign(req, { file, line });
      } else if (hasLine && repo) {
        Object.assign(req, { repo, file, line });
      } else if (hasLine) {
        // No repo: let the server find which known repo holds this line, then ask by address.
        const who = await seance.whois({ file: file!, line: line! }, ctx.signal);
        if (!who.address) return fail(new SeanceError("no_session_for_line", renderWhois(who)));
        Object.assign(req, { address: who.address, file: who.file, line: who.line });
      } else {
        return fail(new SeanceError("bad_request", "Give `address`, or `file` and `line`."));
      }

      const started = Date.now();
      const tick = setInterval(() => {
        const s = Math.round((Date.now() - started) / 1000);
        ctx.reportProgress(s, ASK_TIMEOUT_MS / 1000, `Waiting for the ghost to answer (${s} s)`).catch(() => {});
      }, 10_000);
      let r;
      try {
        r = await seance.ask(req, ctx.signal);
      } finally {
        clearInterval(tick);
      }

      if (r.blocked) {
        return fail(new SeanceError("blocked", `${r.answer}${r.blockedReason ? ` (reason: ${r.blockedReason})` : ""} Session ${r.address}.`));
      }
      const structured = {
        address: r.address, shortId: r.shortId, answer: r.answer, quotes: r.quotes, confidence: r.confidence,
        ...(r.commit ? { commit: r.commit } : {}), durationMs: r.durationMs, blocked: r.blocked, via: r.via, questionId: r.questionId,
      };
      return { content: [{ type: "text" as const, text: renderAnswer(r) }], structuredContent: structured };
    } catch (err) {
      return fail(err);
    }
  },
);

export const whoisLineTool = server.tool(
  {
    name: "whois_line",
    title: "Which session wrote this line?",
    description:
      "Find which Claude Code session wrote a line of code (git blame -> commit -> Agent-Session trailer). Fast and free. " +
      "Returns the session's address to pass to ask_session, or says the line was written by a human / is uncommitted.",
    inputSchema: z.object({
      file: z.string().min(1).describe("Repo-relative path, e.g. src/retry.ts"),
      line: z.number().int().positive().describe("1-based line number"),
      repo: z.string().optional().describe("Absolute repo path on the Séance server's machine. Optional: if omitted, every repo a recorded session worked in is searched, newest first"),
    }),
    outputSchema: z.object({
      repo: z.string().describe("repo folder name"),
      file: z.string(),
      line: z.number(),
      sha: z.string(),
      date: z.string(),
      subject: z.string(),
      address: z.string().nullable().describe("session address, or null if no session is recorded for this line"),
      shortId: z.string().nullable(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  async ({ file, line, repo }, ctx) => {
    try {
      const w = await seance.whois({ file, line, ...(repo ? { repo } : {}) }, ctx.signal);
      const { ok: _ok, ...structured } = w;
      return { content: [{ type: "text" as const, text: renderWhois(w) }], structuredContent: structured };
    } catch (err) {
      return fail(err);
    }
  },
);

export const listSessions = server.tool(
  {
    name: "list_sessions",
    title: "List recorded sessions",
    description: "List the Claude Code sessions Séance has recorded, newest first, with their addresses (usable with ask_session), repo folder, and whether a transcript snapshot exists.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      sessions: z.array(z.object({
        shortId: z.string(),
        address: z.string(),
        repo: z.string(),
        startedAt: z.string(),
        endedAt: z.string().optional(),
        hasSnapshot: z.boolean(),
      })),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  async (_args, ctx) => {
    try {
      const sessions = await seance.sessions(ctx.signal);
      return { content: [{ type: "text" as const, text: renderSessions(sessions) }], structuredContent: { sessions } };
    } catch (err) {
      return fail(err);
    }
  },
);

console.log(
  `[seance-mcp] Séance server ${config.serverUrl} · secret ${config.secret ? "set" : "MISSING"} · ` +
    `MCP token ${config.accessToken ? "required" : "off"} · config from ${config.source}`,
);

export default server;
