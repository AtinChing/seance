import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WhoisResult } from "../shared/git.ts";
import { registerMcpSupportRoutes } from "./mcp-support.ts";
import { FakeRegistry, SEANCE_SECRET, session, testConfig } from "./test-helpers.ts";

function setup(opts: { registry?: FakeRegistry; whois?: (repo: string, file: string, line: number) => Promise<WhoisResult> } = {}) {
  const app = new Hono();
  const registry = opts.registry ?? new FakeRegistry(session());
  registerMcpSupportRoutes(app, { config: testConfig(), registry, whois: opts.whois });
  return { app, registry };
}

const json = { "content-type": "application/json" };
const withSecret = (s: string | null = SEANCE_SECRET): Record<string, string> => (s === null ? json : { ...json, "x-seance-secret": s });
const whoisReq = (app: Hono, body: unknown, secret: string | null = SEANCE_SECRET) =>
  app.request("/api/whois", { method: "POST", headers: withSecret(secret), body: typeof body === "string" ? body : JSON.stringify(body) });

const who = (over: Partial<WhoisResult> = {}): WhoisResult => ({
  file: "src/retry.ts", line: 1, sha: "a".repeat(40), date: "2026-10-18T01:00:00-07:00", subject: "add retry backoff",
  address: "s-7f3a1b2c@example.primitive.email", shortId: "7f3a1b2c", ...over,
});

describe("GET /api/sessions", () => {
  it("requires the secret", async () => {
    const { app } = setup();
    expect((await app.request("/api/sessions")).status).toBe(401);
    const res = await app.request("/api/sessions", { headers: withSecret("wrong") });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("lists newest first with repo basename only", async () => {
    const reg = new FakeRegistry(
      session({ shortId: "aaaaaaaa", address: "s-aaaaaaaa@d", repoPath: "/Users/x/old-repo", startedAt: "2026-10-17T00:00:00.000Z", endedAt: "2026-10-17T01:00:00.000Z" }),
      session({ shortId: "bbbbbbbb", address: "s-bbbbbbbb@d", repoPath: "/Users/x/payments-repo", startedAt: "2026-10-18T00:00:00.000Z", transcriptSnapshot: undefined }),
    );
    const { app } = setup({ registry: reg });
    const res = await app.request("/api/sessions", { headers: withSecret() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      sessions: [
        { shortId: "bbbbbbbb", address: "s-bbbbbbbb@d", repo: "payments-repo", startedAt: "2026-10-18T00:00:00.000Z", hasSnapshot: false },
        { shortId: "aaaaaaaa", address: "s-aaaaaaaa@d", repo: "old-repo", startedAt: "2026-10-17T00:00:00.000Z", endedAt: "2026-10-17T01:00:00.000Z", hasSnapshot: true },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("/Users/x");
  });
});

describe("POST /api/whois", () => {
  it("requires the secret", async () => {
    const { app } = setup({ whois: async () => who() });
    expect((await whoisReq(app, { repo: "/r", file: "a", line: 1 }, null)).status).toBe(401);
    expect((await whoisReq(app, { repo: "/r", file: "a", line: 1 }, "nope")).status).toBe(401);
  });

  it("validates input", async () => {
    const { app } = setup({ whois: async () => who() });
    expect((await whoisReq(app, "not json")).status).toBe(400);
    expect((await whoisReq(app, { line: 1 })).status).toBe(400);
    expect((await whoisReq(app, { file: "a", line: 0 })).status).toBe(400);
    expect((await whoisReq(app, { file: "a", line: 1.5 })).status).toBe(400);
    expect((await whoisReq(app, { file: "a", line: "3" })).status).toBe(400);
    const rel = await whoisReq(app, { repo: "relative/path", file: "a", line: 1 });
    expect(rel.status).toBe(400);
    expect(await rel.json()).toMatchObject({ code: "bad_request" });
  });

  it("returns the whois result for an explicit repo", async () => {
    const calls: string[] = [];
    const { app } = setup({ whois: async (repo, file, line) => { calls.push(`${repo}|${file}|${line}`); return who({ file, line }); } });
    const res = await whoisReq(app, { repo: "/abs/payments-repo", file: "src/retry.ts", line: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, repo: "payments-repo", ...who() });
    expect(calls).toEqual(["/abs/payments-repo|src/retry.ts|1"]);
  });

  it("without repo, tries registered repos newest first and returns the first with a trailer", async () => {
    const reg = new FakeRegistry(
      session({ shortId: "aaaaaaaa", repoPath: "/r/old", startedAt: "2026-10-17T00:00:00.000Z" }),
      session({ shortId: "bbbbbbbb", repoPath: "/r/new", startedAt: "2026-10-18T00:00:00.000Z" }),
      session({ shortId: "cccccccc", repoPath: "/r/new", startedAt: "2026-10-16T00:00:00.000Z" }),
    );
    const tried: string[] = [];
    const { app } = setup({
      registry: reg,
      whois: async (repo) => {
        tried.push(repo);
        if (repo === "/r/new") throw new Error("Command failed: git -C /r/new blame\nfatal: no such path 'x' in HEAD");
        return who();
      },
    });
    const res = await whoisReq(app, { file: "src/retry.ts", line: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, repo: "old", shortId: "7f3a1b2c" });
    expect(tried).toEqual(["/r/new", "/r/old"]);
  });

  it("returns an un-trailered blame (address null) when nothing better exists", async () => {
    const { app } = setup({ whois: async () => who({ address: null, shortId: null, subject: "human commit" }) });
    const res = await whoisReq(app, { repo: "/r/x", file: "a.ts", line: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, address: null, shortId: null, subject: "human commit" });
  });

  it("404s with no_session_for_line when blame fails, without leaking the absolute path", async () => {
    const { app } = setup({ whois: async (repo) => { throw new Error(`Command failed: git -C ${repo} blame\nfatal: no such path 'nope.ts' in HEAD`); } });
    const res = await whoisReq(app, { repo: "/secret/place/demo", file: "nope.ts", line: 1 });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, code: "no_session_for_line" });
    expect(body.error).toContain("no such path");
    expect(body.error).not.toContain("/secret/place");
  });

  it("404s when there is no repo and no sessions", async () => {
    const { app } = setup({ registry: new FakeRegistry(), whois: async () => who() });
    const res = await whoisReq(app, { file: "a.ts", line: 1 });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/whois against a real git repo", () => {
  let repo: string;
  beforeAll(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seance-mcp-support-")));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    fs.writeFileSync(path.join(repo, "a.ts"), "export const X = 1;\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "add x\n\nAgent-Session: s-0badf00d@example.primitive.email");
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("resolves the trailer through shared/git whoisLine", async () => {
    const { app } = setup();
    const res = await whoisReq(app, { repo, file: "a.ts", line: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, file: "a.ts", line: 1, subject: "add x", shortId: "0badf00d", address: "s-0badf00d@example.primitive.email" });
  });
});
