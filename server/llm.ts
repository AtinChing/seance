/**
 * Model gateway (SPEC 6.7). Blaxel sandboxes never see GHOSTS_API_KEY: each ghost run gets a short-lived opaque
 * token, and `ANY /llm/*` swaps that token for the real key on the way to api.anthropic.com.
 *
 * - Tokens expire (default 3 min) and carry a USD budget (default $0.50), counted from the `usage` Anthropic
 *   returns. Over budget, the next request is refused with 402; the request that crosses the line completes.
 * - Responses are streamed back unchanged (SSE included); a pass-through TransformStream reads usage on the way.
 * - Never logs the real key or token values: log lines name the run id only.
 */
import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import type { SeanceConfig } from "../config/index.ts";

export const DEFAULT_TOKEN_TTL_MS = 180_000;
export const DEFAULT_TOKEN_BUDGET_USD = 0.5;
export const DEFAULT_UPSTREAM = "https://api.anthropic.com";

// ---------------------------------------------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------------------------------------------

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheWrite: number; // 5-minute cache writes
  cacheRead: number;
}

/**
 * ESTIMATES, deliberately on the high side so the budget cap errs toward stopping early. Taken from the
 * Anthropic pricing page (platform.claude.com/docs/en/about-claude/pricing, read 2026-10-18), using the most
 * expensive current-ish model in each family: Opus 4.5-5 ($5/$25), Sonnet 4.5/4.6 ($3/$15), Haiku 4.5 ($1/$5),
 * Fable/Mythos 5 ($10/$50). Newer models in a family (e.g. Sonnet 5.5 at $2/$10) are cheaper, so the real
 * cost is at or below what we count. Unknown models are priced as the most expensive family.
 */
export const PRICES: Record<"fable" | "opus" | "sonnet" | "haiku", Price> = {
  fable: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

export function priceFor(model: string | undefined): Price {
  const m = (model ?? "").toLowerCase();
  if (m.includes("haiku")) return PRICES.haiku;
  if (m.includes("sonnet")) return PRICES.sonnet;
  if (m.includes("opus")) return PRICES.opus;
  return PRICES.fable; // fable, mythos, or unknown: assume the most expensive
}

/** The `usage` object on Messages API responses (all fields optional: SSE deltas carry only some). */
export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export function costOf(usage: Usage, model: string | undefined): number {
  const p = priceFor(model);
  return (
    (n(usage.input_tokens) * p.input +
      n(usage.output_tokens) * p.output +
      n(usage.cache_creation_input_tokens) * p.cacheWrite +
      n(usage.cache_read_input_tokens) * p.cacheRead) /
    1_000_000
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------------------------

export type TokenStatus = "valid" | "expired" | "over_budget" | "unknown";

interface TokenEntry {
  runId: string;
  expiresAt: number;
  budgetUsd: number;
  spentUsd: number;
}

export interface MintOptions {
  ttlMs?: number;
  budgetUsd?: number;
}

export class TokenStore {
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** A fresh opaque token for one ghost run: `sgt_` + 32 hex chars. */
  mint(runId: string, opts: MintOptions = {}): string {
    this.sweep();
    const token = `sgt_${randomBytes(16).toString("hex")}`;
    this.tokens.set(token, {
      runId,
      expiresAt: this.now() + (opts.ttlMs ?? DEFAULT_TOKEN_TTL_MS),
      budgetUsd: opts.budgetUsd ?? DEFAULT_TOKEN_BUDGET_USD,
      spentUsd: 0,
    });
    return token;
  }

  check(token: string | undefined | null): TokenStatus {
    const e = token ? this.tokens.get(token) : undefined;
    if (!e) return "unknown";
    if (this.now() >= e.expiresAt) return "expired";
    if (e.spentUsd >= e.budgetUsd) return "over_budget";
    return "valid";
  }

  /** Add the cost of `usage` (priced by model family) to the token. Returns the new total, or null if unknown. */
  addUsage(token: string, usage: Usage, model: string | undefined): number | null {
    return this.addCost(token, costOf(usage, model));
  }

  addCost(token: string, usd: number): number | null {
    const e = this.tokens.get(token);
    if (!e) return null;
    e.spentUsd += Math.max(0, usd);
    return e.spentUsd;
  }

  /** Run id and spend for a token (never the token itself), or null. */
  info(token: string): { runId: string; spentUsd: number; budgetUsd: number; expiresAt: number } | null {
    const e = this.tokens.get(token);
    return e ? { runId: e.runId, spentUsd: e.spentUsd, budgetUsd: e.budgetUsd, expiresAt: e.expiresAt } : null;
  }

  spentUsd(token: string): number | undefined {
    return this.tokens.get(token)?.spentUsd;
  }

  /** Stop a token working right away (the runner calls this when its run ends). */
  revoke(token: string): void {
    this.tokens.delete(token);
  }

  /** Forget tokens that expired more than an hour ago (kept a while so late calls get "expired", not "unknown"). */
  private sweep(): void {
    const cutoff = this.now() - 3_600_000;
    for (const [t, e] of this.tokens) if (e.expiresAt < cutoff) this.tokens.delete(t);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Usage metering over a streamed body
// ---------------------------------------------------------------------------------------------------------------

/**
 * Reads usage from a Messages response as it streams past. Charges incrementally (message_start, then each
 * message_delta), so a client that hangs up mid-stream is still billed for what it got.
 */
class UsageMeter {
  private buf = "";
  private jsonText = "";
  private jsonTooBig = false;
  private readonly decoder = new TextDecoder();
  private model: string | undefined;
  private usage: Usage = {};
  private charged = 0;

  constructor(
    private readonly sse: boolean,
    private readonly charge: (usd: number, model: string | undefined) => void,
    fallbackModel: string | undefined,
  ) {
    this.model = fallbackModel;
  }

  push(chunk: Uint8Array): void {
    const text = this.decoder.decode(chunk, { stream: true });
    if (!this.sse) {
      if (this.jsonText.length + text.length > 16 * 1024 * 1024) this.jsonTooBig = true;
      else this.jsonText += text;
      return;
    }
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      this.line(line);
    }
  }

  end(): void {
    const rest = this.decoder.decode();
    if (!this.sse) {
      if (this.jsonTooBig) return;
      try {
        const body = JSON.parse(this.jsonText + rest);
        if (body && typeof body === "object" && body.usage) {
          if (typeof body.model === "string") this.model = body.model;
          this.update(body.usage);
        }
      } catch {
        // not JSON (an error page, say): nothing to count
      }
      return;
    }
    this.buf += rest;
    if (this.buf) this.line(this.buf);
    this.buf = "";
  }

  private line(line: string): void {
    if (!line.startsWith("data:")) return;
    let ev: any;
    try {
      ev = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    if (ev?.type === "message_start" && ev.message) {
      if (typeof ev.message.model === "string") this.model = ev.message.model;
      if (ev.message.usage) this.update(ev.message.usage);
    } else if (ev?.type === "message_delta" && ev.usage) {
      this.update(ev.usage); // output_tokens here is cumulative; input fields, when present, are totals too
    }
  }

  private update(u: Usage): void {
    for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const) {
      if (typeof u[k] === "number") this.usage[k] = u[k];
    }
    const total = costOf(this.usage, this.model);
    if (total > this.charged) {
      this.charge(total - this.charged, this.model);
      this.charged = total;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

export interface LlmDeps {
  config: SeanceConfig;
  tokens: TokenStore;
  /** Upstream fetch (tests pass a mock). */
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  /** Default https://api.anthropic.com. */
  upstream?: string;
}

/** Request headers forwarded upstream. Everything else (Authorization, x-api-key, cookies, hop-by-hop) is dropped. */
function forwardRequestHeader(name: string): boolean {
  const k = name.toLowerCase();
  if (k === "x-api-key" || k === "authorization") return false;
  return k === "content-type" || k === "accept" || k === "user-agent" || k === "x-app" || k.startsWith("anthropic-") || k.startsWith("x-stainless-");
}

/** Response headers not copied back: the body is re-streamed (and already decompressed by fetch). */
const DROP_RESPONSE_HEADERS = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie",
]);

function anthropicError(c: Context, status: 401 | 402 | 403 | 502, type: string, message: string) {
  return c.json({ type: "error", error: { type, message } }, status);
}

function tokenFrom(c: Context): string | undefined {
  const key = c.req.header("x-api-key")?.trim();
  if (key) return key;
  const auth = c.req.header("authorization")?.trim();
  const m = auth?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : undefined;
}

/**
 * Mounts `ANY /llm/*` on `app`. Mount it before any catch-all routes. The real key is read from
 * `deps.config.ghostsApiKey` on each request, so a missing key yields a 502 instead of a crash at startup.
 */
export function registerLlmRoutes(app: Hono, deps: LlmDeps): void {
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? ((m: string) => console.log(`[llm] ${m}`));
  const upstream = (deps.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, "");
  const { tokens } = deps;

  app.all("/llm/*", async (c) => {
    const token = tokenFrom(c);
    const status = tokens.check(token);
    if (status === "unknown") return anthropicError(c, 401, "authentication_error", "invalid Séance gateway token");
    if (status === "expired") return anthropicError(c, 401, "authentication_error", "Séance gateway token expired");
    if (status === "over_budget") return anthropicError(c, 402, "billing_error", "Séance gateway token is over its budget");
    const realKey = deps.config.ghostsApiKey;
    if (!realKey) return anthropicError(c, 502, "api_error", "the Séance gateway has no upstream key configured");

    const info = tokens.info(token!)!;
    const url = new URL(c.req.url);
    const subPath = url.pathname.replace(/^\/llm(?=\/|$)/, "") || "/";
    const target = `${upstream}${subPath}${url.search}`;

    const headers = new Headers();
    c.req.raw.headers.forEach((v, k) => {
      if (forwardRequestHeader(k)) headers.set(k, v);
    });
    headers.set("x-api-key", realKey);

    const method = c.req.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await c.req.arrayBuffer() : undefined;
    const metered = method === "POST" && subPath === "/v1/messages";
    let requestModel: string | undefined;
    if (metered && body) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(body));
        if (typeof parsed?.model === "string") requestModel = parsed.model;
      } catch {
        // upstream will reject it; nothing to meter
      }
    }

    let res: Response;
    try {
      res = await doFetch(target, { method, headers, body, signal: c.req.raw.signal });
    } catch (e) {
      log(`run ${info.runId}: ${method} ${subPath} upstream failed: ${(e as Error)?.name ?? "error"}`);
      return anthropicError(c, 502, "api_error", "the Séance gateway could not reach the model API");
    }

    const outHeaders = new Headers();
    res.headers.forEach((v, k) => {
      if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) outHeaders.set(k, v);
    });

    const done = (extra = "") =>
      log(`run ${info.runId}: ${method} ${subPath} -> ${res.status}${extra}, spent $${(tokens.spentUsd(token!) ?? 0).toFixed(4)} of $${info.budgetUsd.toFixed(2)}`);

    if (!res.body || !metered || !res.ok) {
      done();
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: outHeaders });
    }

    const sse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
    const meter = new UsageMeter(sse, (usd) => tokens.addCost(token!, usd), requestModel);
    const passthrough = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        try {
          meter.push(chunk);
        } catch {
          // metering must never break the stream
        }
      },
      flush() {
        try {
          meter.end();
        } catch {
          // ignore
        }
        done(sse ? " (stream)" : "");
      },
    });
    return new Response(res.body.pipeThrough(passthrough), { status: res.status, statusText: res.statusText, headers: outHeaders });
  });
}
