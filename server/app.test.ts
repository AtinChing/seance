import { describe, expect, it } from "vitest";
import type { AskResponse } from "../shared/api.ts";
import { BLOCKED_NOTICE } from "./filter.ts";
import { NOTICES } from "./format.ts";
import { RecipientNotAllowedError } from "./mailer.ts";
import {
  ALLOWED, API_KEY, ask, build, DOMAIN, FakeMailer, FakeRegistry, FakeRunner, GHOST, ghostResult, makeEvent,
  postSigned, postWithSecret, SEANCE_SECRET, session, SHORT, WEBHOOK_SECRET, type TestApp,
} from "./test-helpers.ts";

const types = (events: { type: string }[]) => events.map((e) => e.type);

describe("/inbound auth", () => {
  it("accepts a valid Primitive-Signature", async () => {
    const t = build();
    const res = await postSigned(t.app, makeEvent());
    expect(res.status).toBe(200);
    await t.app.drain();
    expect(t.runner.calls).toHaveLength(1);
  });

  it("accepts x-seance-secret", async () => {
    const t = build();
    expect((await postWithSecret(t.app, makeEvent())).status).toBe(200);
    await t.app.drain();
    expect(t.runner.calls).toHaveLength(1);
  });

  it("401s on bad signature, wrong secret, or nothing", async () => {
    const t = build();
    expect((await postSigned(t.app, makeEvent(), "whsec_wrong")).status).toBe(401);
    expect((await postWithSecret(t.app, makeEvent(), "nope")).status).toBe(401);
    expect((await t.app.request("/inbound", { method: "POST", body: JSON.stringify(makeEvent()) })).status).toBe(401);
    // Signed body, then tampered.
    const raw = JSON.stringify(makeEvent());
    const { signWebhookPayload } = await import("@primitivedotdev/sdk/webhook");
    const sig = signWebhookPayload(raw, WEBHOOK_SECRET).header;
    const tampered = raw.replace("0.37", "0.25");
    expect((await t.app.request("/inbound", { method: "POST", headers: { "Primitive-Signature": sig }, body: tampered })).status).toBe(401);
    await t.app.drain();
    expect(t.runner.calls).toHaveLength(0);
  });

  it("ignores other event types with 200", async () => {
    const t = build();
    const res = await postSigned(t.app, makeEvent({ event: "email.sent" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "email.sent" });
    await t.app.drain();
    expect(t.runner.calls).toHaveLength(0);
  });

  it("dedupes on event id and on email id", async () => {
    const t = build();
    const evt = makeEvent({ emailId: "em-1" });
    await postSigned(t.app, evt);
    expect(await (await postSigned(t.app, evt)).json()).toMatchObject({ duplicate: true });
    expect(await (await postSigned(t.app, { ...evt, id: "evt_other" })).json()).toMatchObject({ duplicate: true });
    await t.app.drain();
    expect(t.runner.calls).toHaveLength(1);
  });
});

describe("ghost pipeline", () => {
  it("answers in thread with the spec format and the full event sequence", async () => {
    const t = build();
    await postSigned(t.app, makeEvent({ emailId: "em-q", text: "Why 0.37?\n\nAbout: src/retry.ts:12\n\nOn Sun someone <x@y> wrote:\n> old" }));
    await t.app.drain();

    expect(types(t.events)).toEqual(["email_in", "ghost_waking", "quotes_verified", "reply_sent"]);
    expect(t.events[2]).toMatchObject({ verified: 1, total: 2 });
    expect(t.runner.calls[0]).toMatchObject({ question: "Why 0.37?", file: "src/retry.ts", line: 12, from: ALLOWED, transcriptLocalPath: "/snapshots/snap-key.jsonl" });

    expect(t.mailer.replies).toHaveLength(1);
    expect(t.mailer.replies[0].inboundEmailId).toBe("em-q");
    expect(t.mailer.replies[0].text).toBe([
      "0.25 caused double charges, so I picked 0.37.",
      "",
      `Evidence from session s-${SHORT}'s own history:`,
      '  ✓ "delay 0.25: 2 charges"',
      '  ? "I think 0.37 is safe" (unverified)',
      "",
      `Session s-${SHORT} · commit abcdef0 · answered by a disposable fork in 12s`,
      "The original session was not modified.",
    ].join("\n"));

    const q = t.registry.only();
    expect(q).toMatchObject({ status: "answered", sessionShortId: SHORT, from: ALLOWED, question: "Why 0.37?", file: "src/retry.ts", line: 12, threadId: "th-em-q" });
    expect(q.answeredAt).toBeTruthy();
    expect(q.result?.answer).toContain("0.25 caused double charges");
  });

  it("falls back to the original transcript when there is no snapshot (and logs it)", async () => {
    const t = build({ registry: new FakeRegistry(session({ transcriptSnapshot: undefined })) });
    await postSigned(t.app, makeEvent());
    await t.app.drain();
    expect(t.runner.calls[0].transcriptLocalPath).toBe("/original/transcript.jsonl");
    expect(t.logs.some((l) => l.includes("no transcript snapshot"))).toBe(true);
  });

  it("falls back to the original transcript when the snapshot fails to load", async () => {
    const reg = new FakeRegistry(session());
    reg.failSnapshot = true;
    const t = build({ registry: reg });
    await postSigned(t.app, makeEvent());
    await t.app.drain();
    expect(t.runner.calls[0].transcriptLocalPath).toBe("/original/transcript.jsonl");
  });

  it("replies 'No session with that address.' for an unknown ghost", async () => {
    const t = build();
    await postSigned(t.app, makeEvent({ to: `s-deadbeef@${DOMAIN}` }));
    await t.app.drain();
    expect(t.mailer.replies.map((r) => r.text)).toEqual([NOTICES.unknownSession]);
    expect(t.runner.calls).toHaveLength(0);
  });

  it("blocks a leaky answer, sends the notice, records the rule only", async () => {
    const runner = new FakeRunner(() => ghostResult({ answer: `here you go: ${API_KEY}` }));
    const t = build({ runner });
    await postSigned(t.app, makeEvent());
    await t.app.drain();
    expect(t.mailer.replies.map((r) => r.text)).toEqual([BLOCKED_NOTICE]);
    expect(types(t.events)).toEqual(["email_in", "ghost_waking", "quotes_verified", "reply_blocked"]);
    const q = t.registry.only();
    expect(q.status).toBe("blocked");
    expect(q.blockedReason).toBe("env_value in answer");
    expect(JSON.stringify(q)).not.toContain(API_KEY);
    expect(JSON.stringify(t.events)).not.toContain(API_KEY);
  });

  it("ghost failure -> status error, error event, short apology", async () => {
    const runner = new FakeRunner(() => { throw new Error("claude exited 1 at /secret/path"); });
    const t = build({ runner });
    await postSigned(t.app, makeEvent());
    await t.app.drain();
    expect(t.registry.only().status).toBe("error");
    expect(t.events.at(-1)).toMatchObject({ type: "error", message: "ghost failed to answer" });
    expect(t.mailer.replies.map((r) => r.text)).toEqual([NOTICES.apology]);
    expect(t.mailer.replies[0].text).not.toContain("/secret/path");
  });

  it("recipient_not_allowed keeps the question answered and emits an error event", async () => {
    const mailer = new FakeMailer();
    mailer.replyError = new RecipientNotAllowedError("cannot send to judge@example.com", []);
    const t = build({ mailer });
    const res = await postSigned(t.app, makeEvent());
    expect(res.status).toBe(200);
    await t.app.drain();
    expect(t.registry.only().status).toBe("answered");
    expect(t.events.at(-1)).toEqual({ type: "error", questionId: t.registry.only().id, message: "reply refused by Primitive recipient gate" });
    expect(types(t.events)).not.toContain("reply_sent");
  });
});

describe("routing", () => {
  it("ignores mail to other local parts", async () => {
    const t = build();
    await postSigned(t.app, makeEvent({ to: `hello@${DOMAIN}` }));
    await t.app.drain();
    expect(t.runner.calls).toHaveLength(0);
    expect(t.mailer.replies).toHaveLength(0);
    expect(t.logs.some((l) => l.includes("ignoring mail to hello@"))).toBe(true);
  });

  it("an ask-* reply with nobody waiting is logged and dropped", async () => {
    const t = build();
    await postSigned(t.app, makeEvent({ to: `ask-abc123@${DOMAIN}`, from: GHOST }));
    await t.app.drain();
    expect(t.runner.calls).toHaveLength(0);
    expect(t.mailer.replies).toHaveLength(0);
  });

  it("ignores ghost-to-ghost mail (loop guard)", async () => {
    const t = build();
    await postSigned(t.app, makeEvent({ from: `s-11111111@${DOMAIN}` }));
    await t.app.drain();
    expect(t.runner.calls).toHaveLength(0);
  });
});

describe("sender gate", () => {
  const run = async (opts: Parameters<typeof makeEvent>[0], env?: Record<string, string>) => {
    const t = build({ env });
    await postSigned(t.app, makeEvent(opts));
    await t.app.drain();
    return t;
  };

  it("allowed + authenticated wakes the ghost", async () => {
    expect((await run({ from: ALLOWED, authenticated: true })).runner.calls).toHaveLength(1);
  });

  it("allowed but unauthenticated is refused", async () => {
    const t = await run({ from: ALLOWED, authenticated: false });
    expect(t.runner.calls).toHaveLength(0);
    expect(t.mailer.replies.map((r) => r.text)).toEqual([NOTICES.notApproved]);
  });

  it("a stranger gets the notice once", async () => {
    const t = build();
    await postSigned(t.app, makeEvent({ from: "stranger@example.com" }));
    await postSigned(t.app, makeEvent({ from: "stranger@example.com" }));
    await t.app.drain();
    expect(t.runner.calls).toHaveLength(0);
    expect(t.mailer.replies.map((r) => r.text)).toEqual([NOTICES.notApproved]);
  });

  it("our own ask-* address is allowed", async () => {
    expect((await run({ from: `ask-0a1b2c3d4e@${DOMAIN}` })).runner.calls).toHaveLength(1);
  });

  it("an ask-* address on another domain is not", async () => {
    expect((await run({ from: "ask-0a1b2c3d4e@evil.example" })).runner.calls).toHaveLength(0);
  });

  it("blaxel mode lets anyone ask, authenticated or not", async () => {
    expect((await run({ from: "stranger@example.com", authenticated: false }, { GHOST_RUNNER: "blaxel" })).runner.calls).toHaveLength(1);
  });
});

describe("rate limits", () => {
  it("5/min per sender: 6th gets one notice, 7th is dropped silently", async () => {
    let clock = 1_000_000;
    const t = build({ now: () => clock });
    for (let i = 0; i < 7; i++) {
      await postSigned(t.app, makeEvent());
      await t.app.drain();
      clock += 1000;
    }
    expect(t.runner.calls).toHaveLength(5);
    const notices = t.mailer.replies.filter((r) => r.text === NOTICES.rateLimitedSender);
    expect(notices).toHaveLength(1);
    clock += 60_000;
    await postSigned(t.app, makeEvent());
    await t.app.drain();
    expect(t.runner.calls).toHaveLength(6);
  });

  it("30/hour global, asker addresses included", async () => {
    let clock = 1_000_000;
    const t = build({ now: () => clock, env: { GHOST_RUNNER: "blaxel" } });
    for (let i = 0; i < 31; i++) {
      await postSigned(t.app, makeEvent({ from: i % 2 ? `user${i}@example.com` : `ask-${i}abc@${DOMAIN}` }));
      clock += 1000;
    }
    await t.app.drain();
    expect(t.runner.calls).toHaveLength(30);
    expect(t.mailer.replies.filter((r) => r.text === NOTICES.rateLimitedGlobal)).toHaveLength(1);
  });
});

describe("/api/ask", () => {
  it("401 without the secret", async () => {
    const t = build();
    const res = await ask(t.app, { address: GHOST, question: "why?" }, null);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, code: "unauthorized" });
    expect((await ask(t.app, { address: GHOST, question: "why?" }, "wrong")).status).toBe(401);
  });

  it("400 on bad bodies, 404 unknown session", async () => {
    const t = build({ askMode: "in-process" });
    expect(await (await ask(t.app, { address: GHOST })).json()).toMatchObject({ code: "bad_request" });
    expect(await (await ask(t.app, { question: "why?" })).json()).toMatchObject({ code: "bad_request" });
    expect(await (await ask(t.app, { address: "bob@example.com", question: "why?" })).json()).toMatchObject({ code: "bad_request" });
    const res = await ask(t.app, { address: `s-deadbeef@${DOMAIN}`, question: "why?" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "unknown_session" });
  });

  it("repo+file+line resolves via whois; no trailer -> no_session_for_line", async () => {
    const whois = async (_r: string, file: string, line: number) => ({
      file, line, sha: "a".repeat(40), date: "", subject: "x",
      address: line === 12 ? GHOST : null, shortId: line === 12 ? SHORT : null,
    });
    const t = build({ askMode: "in-process", whois });
    const ok = (await (await ask(t.app, { repo: "/r", file: "src/retry.ts", line: 12, question: "why 0.37?" })).json()) as AskResponse;
    expect(ok).toMatchObject({ ok: true, shortId: SHORT, via: "in-process" });
    expect(t.runner.calls[0]).toMatchObject({ file: "src/retry.ts", line: 12, question: "why 0.37?" });
    expect(await (await ask(t.app, { repo: "/r", file: "src/retry.ts", line: 3, question: "why?" })).json()).toMatchObject({ code: "no_session_for_line" });
  });

  it("in-process mode answers without email", async () => {
    const t = build({ env: { SEANCE_ASK_MODE: "in-process" } });
    const res = await ask(t.app, { address: GHOST, question: "why 0.37?" });
    const body = (await res.json()) as AskResponse;
    expect(body).toMatchObject({
      ok: true, address: GHOST, shortId: SHORT, via: "in-process", blocked: false,
      answer: "0.25 caused double charges, so I picked 0.37.", confidence: "high", runner: "local",
      commit: "abcdef0123456789abcdef0123456789abcdef01",
    });
    expect(t.mailer.sent).toHaveLength(0);
    expect(t.mailer.replies).toHaveLength(0);
    expect(types(t.events)).toEqual(["email_in", "ghost_waking", "quotes_verified", "reply_sent"]);
  });

  it("falls back to in-process when Primitive is not configured", async () => {
    const t = build({ env: { PRIMITIVE_API_KEY: "", PUBLIC_URL: "" } });
    const body = (await (await ask(t.app, { address: GHOST, question: "why?" })).json()) as AskResponse;
    expect(body).toMatchObject({ ok: true, via: "in-process" });
  });

  it("in-process blocked answer returns the notice", async () => {
    const t = build({ askMode: "in-process", runner: new FakeRunner(() => ghostResult({ answer: "ghp_abcdef" })) });
    const body = (await (await ask(t.app, { address: GHOST, question: "leak?" })).json()) as AskResponse;
    expect(body).toMatchObject({ ok: true, blocked: true, answer: BLOCKED_NOTICE, quotes: [], blockedReason: "github_token in answer" });
  });

  it("times out", async () => {
    const t = build({ askMode: "in-process", runner: new FakeRunner(() => new Promise(() => {})) });
    const res = await ask(t.app, { address: GHOST, question: "why?", timeoutMs: 50 });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ ok: false, code: "timeout" });
  });

  it("email path end to end: send -> inbound to ghost -> pipeline -> reply -> inbound to asker -> resolves", async () => {
    const mailer = new FakeMailer();
    const t = build({ mailer, replyGraceMs: 60_000 });
    wireLoopback(t.app, mailer);
    const res = await ask(t.app, { address: GHOST, question: "why 0.37?", file: "src/retry.ts", line: 12 });
    const body = (await res.json()) as AskResponse;
    expect(body).toMatchObject({ ok: true, via: "email", shortId: SHORT, answer: "0.25 caused double charges, so I picked 0.37.", blocked: false });
    if (body.ok) expect(body.quotes).toHaveLength(2);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: GHOST, subject: "Why is src/retry.ts:12 the way it is?" });
    expect(mailer.sent[0].from).toMatch(new RegExp(`^ask-[0-9a-f]+@${DOMAIN.replace(/\./g, "\\.")}$`));
    expect(mailer.sent[0].text).toBe("why 0.37?\n\nAbout: src/retry.ts:12");
    expect(mailer.replies).toHaveLength(1);
    expect(t.runner.calls[0]).toMatchObject({ file: "src/retry.ts", line: 12, question: "why 0.37?" });
    expect(t.logs.some((l) => l.includes("reply to ask-") && l.includes("nobody waiting"))).toBe(false);
  });

  it("email path resolves from the pipeline when Primitive refuses the reply", async () => {
    const mailer = new FakeMailer();
    mailer.replyError = new RecipientNotAllowedError("nope", []);
    const t = build({ mailer, replyGraceMs: 60_000 });
    wireLoopback(t.app, mailer);
    const body = (await (await ask(t.app, { address: GHOST, question: "why?", timeoutMs: 5000 })).json()) as AskResponse;
    expect(body).toMatchObject({ ok: true, via: "email" });
  });

  it("email path resolves from the pipeline after the grace period if the reply never comes back", async () => {
    const mailer = new FakeMailer();
    const t = build({ mailer, replyGraceMs: 20 });
    wireLoopback(t.app, mailer, { dropReplies: true });
    const body = (await (await ask(t.app, { address: GHOST, question: "why?", timeoutMs: 5000 })).json()) as AskResponse;
    expect(body).toMatchObject({ ok: true, via: "email" });
  });

  it("email path times out if the question never arrives", async () => {
    const t = build();
    const res = await ask(t.app, { address: GHOST, question: "why?", timeoutMs: 50 });
    expect(res.status).toBe(504);
  });

  it("email path: send failure is a clean internal error", async () => {
    const mailer = new FakeMailer();
    mailer.sendError = new Error("boom");
    const t = build({ mailer });
    const res = await ask(t.app, { address: GHOST, question: "why?" });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, code: "internal" });
  });
});

describe("/events and /healthz", () => {
  it("streams a snapshot, then live events, then heartbeats", async () => {
    const t = build({ heartbeatMs: 30 });
    const res = await t.app.request("/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readUntil = async (needle: string) => {
      while (!buf.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += dec.decode(value);
      }
    };
    await readUntil("event: snapshot");
    t.bus.emit({ type: "ghost_waking", questionId: "q_1", runner: "local" });
    await readUntil('"type":"ghost_waking"');
    await readUntil(": heartbeat");
    await reader.cancel();
    expect(buf).toContain('data: {"type":"ghost_waking","questionId":"q_1","runner":"local"}');
  });

  it("snapshot includes recent questions", async () => {
    const t = build();
    await postSigned(t.app, makeEvent());
    await t.app.drain();
    const res = await t.app.request("/events");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: snapshot");
    expect(text).toContain(t.registry.only().id);
  });

  it("/healthz reports config presence, never values", async () => {
    const t = build();
    const res = await t.app.request("/healthz");
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: true, config: { SEANCE_SECRET: "set", PRIMITIVE_DOMAIN: DOMAIN } });
    for (const s of [SEANCE_SECRET, WEBHOOK_SECRET, API_KEY]) expect(text).not.toContain(s);
  });

  it("/tower is a 501 placeholder", async () => {
    expect((await build().app.request("/tower")).status).toBe(501);
  });
});

/**
 * Simulates Primitive: a send() to the ghost arrives at /inbound as a new thread;
 * a reply() goes back to the original sender at /inbound on the same thread_id.
 */
function wireLoopback(app: TestApp, mailer: FakeMailer, opts: { dropReplies?: boolean } = {}) {
  const inbound = new Map<string, { from: string; to: string; subject: string; threadId: string }>();
  let n = 0;
  mailer.onSend = (m) => {
    const emailId = `loop-${++n}`;
    const threadId = `thread-${n}`;
    inbound.set(emailId, { from: m.from, to: m.to, subject: m.subject, threadId });
    setTimeout(() => void postSigned(app, makeEvent({ emailId, threadId, from: m.from, to: m.to, subject: m.subject, text: m.text })), 5);
  };
  mailer.onReply = (r) => {
    if (opts.dropReplies) return;
    const parent = inbound.get(r.inboundEmailId);
    if (!parent) return;
    setTimeout(() => void postSigned(app, makeEvent({
      emailId: `loop-${++n}`, threadId: parent.threadId, from: parent.to, to: parent.from, subject: `Re: ${parent.subject}`, text: r.text,
    })), 5);
  };
}
