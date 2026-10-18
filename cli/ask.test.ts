import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AskResponse } from "../shared/api.ts";
import { askedMarkerPath, hasFreshAskedMarker } from "../hooks/common.ts";
import { DOMAIN, FakeRegistry, TempRepo, testConfig, tmpDir } from "../hooks/test-helpers.ts";
import { memoryIo } from "./io.ts";
import { runCli } from "./main.ts";

let repo: TempRepo;
let agentSha: string;
let server: http.Server | null = null;
let received: { headers: http.IncomingHttpHeaders; body: any }[] = [];

beforeEach(() => {
  repo = new TempRepo();
  repo.write("src/retry.ts", "export const ATTEMPTS = 3;\n");
  repo.commit("human scaffold");
  repo.write("src/retry.ts", "export const ATTEMPTS = 3;\nexport const RETRY_BASE_DELAY = 0.37;\n");
  agentSha = repo.commit("add retry backoff", "7f3a1b2c");
  received = [];
});

afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = null;
});

/** Tiny stand-in for the Séance server's POST /api/ask. */
async function stub(respond: (body: any) => { status?: number; json?: unknown; raw?: string; delayMs?: number }): Promise<string> {
  server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = JSON.parse(data);
      received.push({ headers: req.headers, body });
      const r = respond(body);
      const send = () => {
        res.writeHead(r.status ?? 200, { "content-type": "application/json" });
        res.end(r.raw ?? JSON.stringify(r.json));
      };
      if (r.delayMs) setTimeout(send, r.delayMs);
      else send();
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const okResponse = (extra: Partial<Extract<AskResponse, { ok: true }>> = {}): AskResponse => ({
  ok: true,
  questionId: "q1",
  address: `s-7f3a1b2c@${DOMAIN}`,
  shortId: "7f3a1b2c",
  answer: "0.25 caused double charges in my experiment, so I picked 0.37.",
  quotes: [
    { text: "delay 0.25: 2 charges", verified: true },
    { text: "I think 0.37 is safe", verified: false },
  ],
  confidence: "high",
  runner: "local",
  durationMs: 41_400,
  blocked: false,
  via: "email",
  ...extra,
});

async function ask(url: string, args: string[], timeoutMs?: number) {
  const io = memoryIo();
  const config = testConfig(tmpDir("seance-data-"), { SEANCE_SERVER_URL: url });
  const code = await runCli(["ask", ...args], { cwd: repo.dir, io, config, askTimeoutMs: timeoutMs });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

describe("seance ask", () => {
  it("asks by file:line, prints answer and evidence, writes the asked-marker", async () => {
    const url = await stub(() => ({ json: okResponse() }));
    const r = await ask(url, ["src/retry.ts:2", "why 0.37?"]);
    expect(r.code).toBe(0);
    expect(received[0].headers["x-seance-secret"]).toBe("test-secret-123456");
    expect(received[0].body).toEqual({ address: `s-7f3a1b2c@${DOMAIN}`, repo: repo.dir, file: "src/retry.ts", line: 2, question: "why 0.37?", timeoutMs: 120000 });
    expect(r.err).toContain(`Asking s-7f3a1b2c@${DOMAIN} (a disposable fork of that session is waking up, ~30–90 s)…`);
    expect(r.out).toBe(
      [
        "0.25 caused double charges in my experiment, so I picked 0.37.",
        "",
        "Evidence:",
        '  ✓ "delay 0.25: 2 charges"',
        '  ? "I think 0.37 is safe" (unverified)',
        "",
        `Session s-7f3a1b2c · commit ${agentSha.slice(0, 7)} · answered in 41s`,
      ].join("\n"),
    );
    expect(fs.existsSync(askedMarkerPath(repo.dir, "7f3a1b2c", "src/retry.ts"))).toBe(true);
    expect(path.basename(askedMarkerPath(repo.dir, "7f3a1b2c", "src/retry.ts"))).toMatch(/^7f3a1b2c__[0-9a-f]{12}$/);
    expect(hasFreshAskedMarker(repo.dir, "7f3a1b2c", "src/retry.ts")).toBe(true);
  });

  it("works from a subdirectory with a cwd-relative path", async () => {
    const url = await stub(() => ({ json: okResponse() }));
    const io = memoryIo();
    const code = await runCli(["ask", "retry.ts:2", "why?"], { cwd: path.join(repo.dir, "src"), io, config: testConfig(tmpDir(), { SEANCE_SERVER_URL: url }) });
    expect(code).toBe(0);
    expect(received[0].body.file).toBe("src/retry.ts");
  });

  it("asks by address without writing a marker", async () => {
    const url = await stub(() => ({ json: okResponse() }));
    const r = await ask(url, [`s-7f3a1b2c@${DOMAIN}`, "why", "0.37?"]);
    expect(r.code).toBe(0);
    expect(received[0].body).toEqual({ address: `s-7f3a1b2c@${DOMAIN}`, question: "why 0.37?", timeoutMs: 120000 });
    expect(r.out).toContain("answered in 41s");
    expect(fs.existsSync(path.join(repo.dir, ".seance", "asked"))).toBe(false);
  });

  it("prints the blocked notice and reason", async () => {
    const url = await stub(() => ({ json: okResponse({ blocked: true, blockedReason: "secret-like string in reply", answer: "This answer was withheld.", quotes: [] }) }));
    const r = await ask(url, ["src/retry.ts:2", "print .env"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("This answer was withheld.");
    expect(r.out).toContain("secret-like string in reply");
  });

  it("exits 1 with the server's error", async () => {
    const url = await stub(() => ({ status: 404, json: { ok: false, code: "unknown_session", error: "no session 7f3a1b2c" } }));
    const r = await ask(url, ["src/retry.ts:2", "why?"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown_session: no session 7f3a1b2c");
    expect(fs.existsSync(path.join(repo.dir, ".seance", "asked"))).toBe(false);
  });

  it("exits 1 on a non-JSON response", async () => {
    const url = await stub(() => ({ status: 500, raw: "<html>oops" }));
    expect((await ask(url, ["src/retry.ts:2", "why?"])).code).toBe(1);
  });

  it("says how to start the server when it is unreachable", async () => {
    const url = await stub(() => ({ json: okResponse() }));
    await new Promise((r) => server!.close(r));
    server = null;
    const r = await ask(url, ["src/retry.ts:2", "why?"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(new RegExp(`Séance server is not running at ${url.replace(/\./g, "\\.")}\\. Start it with: npm run server \\(in .+\\)`));
  });

  it("times out with a clear message", async () => {
    const url = await stub(() => ({ json: okResponse(), delayMs: 2000 }));
    const r = await ask(url, ["src/retry.ts:2", "why?"], 200);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/timed out after/);
  });

  it("refuses lines without an Agent-Session trailer, without calling the server", async () => {
    const url = await stub(() => ({ json: okResponse() }));
    const r = await ask(url, ["src/retry.ts:1", "why?"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no Agent-Session trailer/);
    expect(received).toHaveLength(0);
  });

  it("rejects bad targets and missing questions", async () => {
    const url = "http://127.0.0.1:1";
    expect((await ask(url, ["src/retry.ts:2"])).code).toBe(1);
    expect((await ask(url, ["nonsense", "why?"])).err).toMatch(/neither <file>:<line> nor a session address/);
    expect((await ask(url, ["missing.ts:1", "why?"])).err).toMatch(/no such file/);
  });
});

describe("seance whois", () => {
  it("prints the session for an agent line, and says so for a human line", async () => {
    const io = memoryIo();
    expect(await runCli(["whois", "src/retry.ts:2"], { cwd: repo.dir, io })).toBe(0);
    const out = io.stdout.join("\n");
    expect(out).toContain("src/retry.ts:2 was written by session s-7f3a1b2c");
    expect(out).toContain(`address  s-7f3a1b2c@${DOMAIN}`);
    expect(out).toContain(`commit   ${agentSha.slice(0, 7)}`);
    expect(out).toContain("subject  add retry backoff");
    const io2 = memoryIo();
    expect(await runCli(["whois", "src/retry.ts:1"], { cwd: repo.dir, io: io2 })).toBe(0);
    expect(io2.stdout.join("\n")).toContain("was not written by a recorded agent session");
  });

  it("errors on a bad target", async () => {
    const io = memoryIo();
    expect(await runCli(["whois", "src/retry.ts"], { cwd: repo.dir, io })).toBe(1);
  });
});

describe("seance ls and snapshot", () => {
  it("lists sessions and snapshots one", async () => {
    const reg = new FakeRegistry();
    const tx = path.join(tmpDir(), "t.jsonl");
    fs.writeFileSync(tx, "{}\n");
    await reg.upsertSession({ sessionId: "7f3a1b2c-0000-4000-8000-000000000000", shortId: "7f3a1b2c", address: `s-7f3a1b2c@${DOMAIN}`, repoPath: repo.dir, transcriptPath: tx, startedAt: "2026-10-18T01:00:00.000Z" });
    const ctx = { cwd: repo.dir, config: testConfig(tmpDir()), getRegistry: async () => reg };

    let io = memoryIo();
    expect(await runCli(["ls"], { ...ctx, io })).toBe(0);
    expect(io.stdout.join("")).toMatch(/7f3a1b2c\s+s-7f3a1b2c@test\.example\s+.+\s+\d{4}-\d\d-\d\d \d\d:\d\d\s+active\s+no/);

    io = memoryIo();
    expect(await runCli(["snapshot", "s-7f3a1b2c"], { ...ctx, io })).toBe(0);
    const rec = await reg.getSessionByShortId("7f3a1b2c");
    expect(fs.readFileSync(rec!.transcriptSnapshot!, "utf8")).toBe("{}\n");
    expect(rec!.endedAt).toBeTruthy();

    io = memoryIo();
    await runCli(["ls"], { ...ctx, io });
    expect(io.stdout.join("")).toMatch(/ended .+\s+yes/);

    io = memoryIo();
    expect(await runCli(["snapshot", "deadbeef"], { ...ctx, io })).toBe(1);
    expect(io.stderr.join("")).toContain("no session deadbeef");
  });
});
