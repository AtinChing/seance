import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/index.ts";
import { costOf, priceFor, PRICES, registerLlmRoutes, TokenStore } from "./llm.ts";

const REAL_KEY = "sk-ant-real-ghosts-key-never-leaves-0123456789";
const config = loadConfig({ envFile: null, env: { GHOSTS_API_KEY: REAL_KEY } });

interface Call {
  url: string;
  init: RequestInit & { headers: Headers };
}

function setup(opts: { now?: () => number; respond?: (call: Call) => Response | Promise<Response> } = {}) {
  const tokens = new TokenStore({ now: opts.now });
  const calls: Call[] = [];
  const logs: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init as Call["init"] };
    calls.push(call);
    return opts.respond ? opts.respond(call) : jsonResponse({ id: "msg_1", model: "claude-sonnet-4-5", usage: { input_tokens: 1000, output_tokens: 100 } });
  });
  const app = new Hono();
  registerLlmRoutes(app, { config, tokens, fetch: fetchMock as unknown as typeof fetch, log: (m) => logs.push(m) });
  return { app, tokens, calls, logs, fetchMock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_1" } });
}

const MSG_BODY = JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });

function post(app: Hono, path: string, headers: Record<string, string>, body = MSG_BODY) {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

describe("TokenStore", () => {
  it("mints opaque tokens and checks them", () => {
    const t = new TokenStore();
    const tok = t.mint("run1");
    expect(tok).toMatch(/^sgt_[0-9a-f]{32}$/);
    expect(t.mint("run1")).not.toBe(tok);
    expect(t.check(tok)).toBe("valid");
    expect(t.check("sgt_nope")).toBe("unknown");
    expect(t.check(undefined)).toBe("unknown");
  });

  it("expires after the ttl (default 3 minutes)", () => {
    let now = 1_000_000;
    const t = new TokenStore({ now: () => now });
    const tok = t.mint("r");
    now += 179_999;
    expect(t.check(tok)).toBe("valid");
    now += 1;
    expect(t.check(tok)).toBe("expired");
    const short = t.mint("r2", { ttlMs: 10 });
    now += 10;
    expect(t.check(short)).toBe("expired");
  });

  it("goes over budget once spend reaches the cap (default $0.50)", () => {
    const t = new TokenStore();
    const tok = t.mint("r");
    // sonnet: 100k input = $0.30
    expect(t.addUsage(tok, { input_tokens: 100_000 }, "claude-sonnet-4-5")).toBeCloseTo(0.3);
    expect(t.check(tok)).toBe("valid");
    t.addUsage(tok, { output_tokens: 20_000 }, "claude-sonnet-4-5"); // + $0.30
    expect(t.check(tok)).toBe("over_budget");
    expect(t.addUsage("sgt_unknown", { input_tokens: 1 }, "x")).toBeNull();
  });

  it("revoke stops a token at once", () => {
    const t = new TokenStore();
    const tok = t.mint("r");
    t.revoke(tok);
    expect(t.check(tok)).toBe("unknown");
  });
});

describe("pricing", () => {
  it("prices by family and treats unknown models as the most expensive", () => {
    expect(priceFor("claude-opus-4-5")).toBe(PRICES.opus);
    expect(priceFor("claude-sonnet-5-5")).toBe(PRICES.sonnet);
    expect(priceFor("claude-haiku-4-5-20251001")).toBe(PRICES.haiku);
    expect(priceFor("mystery-model")).toBe(PRICES.fable);
    expect(costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }, "claude-haiku-4-5"))
      .toBeCloseTo(1 + 5 + 1.25 + 0.1);
  });
});

describe("ANY /llm/*", () => {
  it("swaps the run token for the real key and forwards path, query and API headers", async () => {
    const { app, tokens, calls } = setup();
    const tok = tokens.mint("run-a");
    const res = await post(app, "/llm/v1/messages?beta=true", {
      "x-api-key": tok,
      authorization: "Bearer something-else",
      cookie: "a=b",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(init.method).toBe("POST");
    const h = init.headers;
    expect(h.get("x-api-key")).toBe(REAL_KEY);
    expect(h.get("authorization")).toBeNull();
    expect(h.get("cookie")).toBeNull();
    expect(h.get("anthropic-version")).toBe("2023-06-01");
    expect(h.get("anthropic-beta")).toBe("prompt-caching-2024-07-31");
    expect(h.get("content-type")).toBe("application/json");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(MSG_BODY);
    expect(res.headers.get("request-id")).toBe("req_1");
  });

  it("accepts the token as Authorization: Bearer too", async () => {
    const { app, tokens, calls } = setup();
    const tok = tokens.mint("run-b");
    const res = await post(app, "/llm/v1/messages", { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(200);
    expect(calls[0].init.headers.get("x-api-key")).toBe(REAL_KEY);
    expect(calls[0].init.headers.get("authorization")).toBeNull();
  });

  it("never echoes or logs the real key or the token", async () => {
    const { app, tokens, logs } = setup({
      respond: () => jsonResponse({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, 400),
    });
    const tok = tokens.mint("run-c");
    const res = await post(app, "/llm/v1/messages", { "x-api-key": tok });
    const text = await res.text();
    const headerDump = JSON.stringify([...res.headers]);
    for (const s of [REAL_KEY, tok]) {
      expect(text).not.toContain(s);
      expect(headerDump).not.toContain(s);
      expect(logs.join("\n")).not.toContain(s);
    }
    expect(logs.join("\n")).toContain("run-c");
    // and the rejection paths
    const bad = await post(app, "/llm/v1/messages", { "x-api-key": REAL_KEY });
    expect(await bad.text()).not.toContain(REAL_KEY);
  });

  it("rejects missing, unknown and expired tokens with 401 in Anthropic's error shape", async () => {
    let now = 0;
    const { app, tokens, fetchMock } = setup({ now: () => now });
    const none = await post(app, "/llm/v1/messages", {});
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ type: "error", error: { type: "authentication_error", message: expect.any(String) } });
    expect((await post(app, "/llm/v1/messages", { "x-api-key": "sgt_" + "0".repeat(32) })).status).toBe(401);

    const tok = tokens.mint("run-d");
    expect((await post(app, "/llm/v1/messages", { "x-api-key": tok })).status).toBe(200);
    now += 180_000;
    const expired = await post(app, "/llm/v1/messages", { "x-api-key": tok });
    expect(expired.status).toBe(401);
    expect((await expired.json()).error.message).toMatch(/expired/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cuts off with 402 once the budget is spent", async () => {
    const { app, tokens, fetchMock } = setup({
      // sonnet: 100k in + 10k out = $0.30 + $0.15 = $0.45 per call
      respond: () => jsonResponse({ model: "claude-sonnet-4-5", usage: { input_tokens: 100_000, output_tokens: 10_000 } }),
    });
    const tok = tokens.mint("run-e");
    const r1 = await post(app, "/llm/v1/messages", { "x-api-key": tok });
    await r1.text();
    expect(tokens.spentUsd(tok)).toBeCloseTo(0.45);
    const r2 = await post(app, "/llm/v1/messages", { "x-api-key": tok });
    await r2.text();
    expect(tokens.spentUsd(tok)).toBeCloseTo(0.9);
    const r3 = await post(app, "/llm/v1/messages", { "x-api-key": tok });
    expect(r3.status).toBe(402);
    expect((await r3.json()).error.type).toBe("billing_error");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not charge for non-/v1/messages paths (count_tokens, models)", async () => {
    const { app, tokens, calls } = setup({
      respond: () => jsonResponse({ input_tokens: 5000, usage: { input_tokens: 999_999 } }),
    });
    const tok = tokens.mint("run-f");
    await (await post(app, "/llm/v1/messages/count_tokens", { "x-api-key": tok })).text();
    await (await app.request("/llm/v1/models", { headers: { "x-api-key": tok } })).text();
    expect(calls.map((c) => c.url)).toEqual(["https://api.anthropic.com/v1/messages/count_tokens", "https://api.anthropic.com/v1/models"]);
    expect(calls[1].init.method).toBe("GET");
    expect(calls[1].init.body).toBeUndefined();
    expect(tokens.spentUsd(tok)).toBe(0);
  });

  it("streams SSE through chunk by chunk and counts message_start + message_delta usage", async () => {
    const enc = new TextEncoder();
    let push!: (s: string) => void;
    let close!: () => void;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (s) => controller.enqueue(enc.encode(s));
        close = () => controller.close();
      },
    });
    const { app, tokens } = setup({
      respond: () => new Response(upstreamBody, { status: 200, headers: { "content-type": "text/event-stream", "content-encoding": "gzip" } }),
    });
    const tok = tokens.mint("run-g");
    const res = await post(app, "/llm/v1/messages", { "x-api-key": tok });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("content-encoding")).toBeNull();
    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    const start = `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { model: "claude-opus-4-5", usage: { input_tokens: 10_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, output_tokens: 1 } },
    })}\n\n`;
    push(start);
    // the first event reaches the client before the upstream sends anything else
    const first = await reader.read();
    expect(dec.decode(first.value)).toBe(start);
    // opus: 10k in = $0.05, 100k cache read = $0.05, 1 out
    expect(tokens.spentUsd(tok)).toBeCloseTo(0.1, 3);

    // an event split across two chunks
    const delta = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2000 } })}\n\n`;
    push(delta.slice(0, 30));
    expect(dec.decode((await reader.read()).value)).toBe(delta.slice(0, 30));
    push(delta.slice(30));
    expect(dec.decode((await reader.read()).value)).toBe(delta.slice(30));
    // output is cumulative: 2000 * $25/M = $0.05 on top
    expect(tokens.spentUsd(tok)).toBeCloseTo(0.15, 3);

    push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
    close();
    let rest = "";
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      rest += dec.decode(r.value);
    }
    expect(rest).toContain("message_stop");
    expect(tokens.spentUsd(tok)).toBeCloseTo(0.15, 3);
  });

  it("counts usage from a JSON response, using the response's model", async () => {
    const { app, tokens } = setup({
      respond: () => jsonResponse({ model: "claude-haiku-4-5", usage: { input_tokens: 200_000, output_tokens: 20_000 } }),
    });
    const tok = tokens.mint("run-h");
    const res = await post(app, "/llm/v1/messages", { "x-api-key": tok });
    expect((await res.json()).model).toBe("claude-haiku-4-5");
    expect(tokens.spentUsd(tok)).toBeCloseTo(0.2 + 0.1);
  });

  it("returns 502 without leaking anything when upstream is unreachable", async () => {
    const { app, tokens } = setup({ respond: () => { throw new Error(`connect failed ${REAL_KEY}`); } });
    const tok = tokens.mint("run-i");
    const res = await post(app, "/llm/v1/messages", { "x-api-key": tok });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(REAL_KEY);
  });
});
