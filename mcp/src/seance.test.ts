// Run from the Séance root: npx vitest run mcp
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMcpConfig } from "./config.js";
import { normalizeAddress, renderAnswer, renderSessions, renderWhois, SeanceClient, SeanceError, errorText, type AskOk } from "./seance.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const okAsk: AskOk = {
  ok: true, questionId: "q_1", address: "s-055fcb2d@safe-maple.primitive.email", shortId: "055fcb2d",
  answer: "0.25 double charged; 0.37 never did.", quotes: [{ text: "baseDelay=0.25s charges=2", verified: true }, { text: "made up", verified: false }],
  confidence: "high", runner: "local", durationMs: 12_345, commit: "28f1f6458bdfd34eeece11e72c669b0bd99aff4a", blocked: false, via: "email",
};

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof SeanceError ? e.code : `other: ${String(e)}`;
  }
}

describe("SeanceClient", () => {
  it("sends the secret header, JSON body and the 120 s server timeout", async () => {
    const calls: Call[] = [];
    const c = new SeanceClient({ serverUrl: "http://x:1/", secret: "s3cret", fetch: fakeFetch(200, okAsk, calls) });
    const r = await c.ask({ address: "s-055fcb2d", question: "why?" });
    expect(r.answer).toContain("0.37");
    expect(calls[0].url).toBe("http://x:1/api/ask");
    expect((calls[0].init.headers as Record<string, string>)["x-seance-secret"]).toBe("s3cret");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ timeoutMs: 120_000, address: "s-055fcb2d", question: "why?" });
  });

  it("maps server error codes", async () => {
    for (const code of ["unknown_session", "no_session_for_line", "timeout", "unauthorized", "bad_request", "internal"]) {
      const c = new SeanceClient({ serverUrl: "http://x", secret: "s", fetch: fakeFetch(400, { ok: false, code, error: "boom" }) });
      expect(await codeOf(c.ask({ address: "a", question: "q" }))).toBe(code);
    }
  });

  it("maps transport failures", async () => {
    const mk = (f: typeof fetch) => new SeanceClient({ serverUrl: "http://x", secret: "s", fetch: f });
    expect(await codeOf(mk(fakeFetch(404, "Not Found")).sessions())).toBe("not_supported");
    expect(await codeOf(mk(fakeFetch(524, "<html>")).ask({ question: "q", address: "a" }))).toBe("timeout");
    expect(await codeOf(mk(fakeFetch(502, "<html>")).sessions())).toBe("unreachable");
    expect(await codeOf(mk((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch).sessions())).toBe("unreachable");
    expect(await codeOf(new SeanceClient({ serverUrl: "http://x", fetch: fakeFetch(200, {}) }).sessions())).toBe("unauthorized");
  });

  it("gives every error code an actionable hint", () => {
    const t = errorText(new SeanceError("unknown_session", "No session s-deadbeef"));
    expect(t).toContain("unknown_session");
    expect(t).toContain("list_sessions");
  });
});

describe("rendering", () => {
  it("marks verified and unverified quotes clearly", () => {
    const t = renderAnswer(okAsk);
    expect(t).toContain("s-055fcb2d");
    expect(t).toContain("commit 28f1f64");
    expect(t).toContain("12.3 s");
    expect(t).toContain('✓ VERIFIED  "baseDelay=0.25s charges=2"');
    expect(t).toContain('? UNVERIFIED "made up"');
    expect(t).toContain("1/2 verified");
  });

  it("whois: session, human, uncommitted", () => {
    const base = { ok: true as const, repo: "r", file: "a.ts", line: 3, sha: "b".repeat(40), date: "2026-10-18", subject: "s" };
    expect(renderWhois({ ...base, address: "s-1@d", shortId: "1" })).toContain("ask_session");
    expect(renderWhois({ ...base, address: null, shortId: null })).toContain("no Agent-Session trailer");
    expect(renderWhois({ ...base, sha: "0".repeat(40), address: null, shortId: null })).toContain("uncommitted");
  });

  it("sessions", () => {
    expect(renderSessions([])).toContain("No Séance sessions");
    expect(renderSessions([{ shortId: "1", address: "s-1@d", repo: "r", startedAt: "t", hasSnapshot: true }])).toContain("s-1@d");
  });

  it("normalizes bare short ids", () => {
    expect(normalizeAddress("055FCB2D")).toBe("s-055fcb2d");
    expect(normalizeAddress(" s-055fcb2d@x.y ")).toBe("s-055fcb2d@x.y");
  });
});

describe("loadMcpConfig", () => {
  it("prefers the process env and defaults the URL", () => {
    const c = loadMcpConfig({ SEANCE_SECRET: "a", SEANCE_SERVER_URL: "https://t.example/", SEANCE_MCP_TOKEN: "tok" });
    expect(c).toMatchObject({ secret: "a", serverUrl: "https://t.example", accessToken: "tok", source: "env" });
    expect(loadMcpConfig({ SEANCE_ENV_FILE: "none" }).serverUrl).toBe("http://localhost:8787");
  });

  it("reads only the needed keys from an env file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seance-mcp-cfg-"));
    const f = path.join(dir, ".env");
    fs.writeFileSync(f, "SEANCESECRET=fromfile\nPORT=9999\nGHOSTS_API_KEY=nope\n");
    const c = loadMcpConfig({ SEANCE_ENV_FILE: f });
    expect(c).toMatchObject({ secret: "fromfile", serverUrl: "http://localhost:9999" });
    expect(JSON.stringify(c)).not.toContain("nope");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
