import { describe, expect, it, vi } from "vitest";
import { isRecipientNotAllowed, PrimitiveMailer, PrimitiveSendError, RecipientNotAllowedError } from "./mailer.ts";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("PrimitiveMailer", () => {
  it("send posts /v1/send-mail with bearer auth and a fresh idempotency key", async () => {
    const f = fakeFetch(200, { success: true, data: { id: "sent-1", status: "queued" } });
    const m = new PrimitiveMailer({ apiKey: "prim_test", fetch: f as unknown as typeof fetch });
    const r1 = await m.send({ from: "ask-1@d.example", to: "s-7f3a1b2c@d.example", subject: "Q", text: "why?" });
    await m.send({ from: "ask-1@d.example", to: "s-7f3a1b2c@d.example", subject: "Q", text: "why?" });
    expect(r1).toEqual({ messageId: "sent-1", threadId: "sent-1" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.primitive.dev/v1/send-mail");
    const h = init!.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer prim_test");
    expect(h["Idempotency-Key"]).toBeTruthy();
    expect(h["Idempotency-Key"]).not.toBe((f.mock.calls[1][1]!.headers as Record<string, string>)["Idempotency-Key"]);
    expect(JSON.parse(init!.body as string)).toEqual({ from: "ask-1@d.example", to: "s-7f3a1b2c@d.example", subject: "Q", body_text: "why?" });
  });

  it("reply posts /v1/emails/{id}/reply with only the body (threading is server-side)", async () => {
    const f = fakeFetch(200, { success: true, data: { id: "sent-2" } });
    const m = new PrimitiveMailer({ apiKey: "prim_test", fetch: f as unknown as typeof fetch });
    const r = await m.reply("6d50cabb-d261", "answer", { idempotencyKey: "k1" });
    expect(r).toEqual({ messageId: "sent-2", threadId: "6d50cabb-d261" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.primitive.dev/v1/emails/6d50cabb-d261/reply");
    expect(JSON.parse(init!.body as string)).toEqual({ body_text: "answer" });
    expect((init!.headers as Record<string, string>)["Idempotency-Key"]).toBe("k1");
  });

  it("maps 403 recipient_not_allowed to a typed error", async () => {
    const f = fakeFetch(403, {
      success: false,
      error: { code: "recipient_not_allowed", message: "cannot send to judge@example.com", gates: [{ name: "send_to_known_addresses", reason: "recipient_not_known" }] },
    });
    const m = new PrimitiveMailer({ apiKey: "prim_test", fetch: f as unknown as typeof fetch });
    const err = await m.reply("id", "x").catch((e) => e);
    expect(err).toBeInstanceOf(RecipientNotAllowedError);
    expect(isRecipientNotAllowed(err)).toBe(true);
    expect(err.gates[0].name).toBe("send_to_known_addresses");
    expect(String(err.message)).not.toContain("prim_test");
  });

  it("other failures become PrimitiveSendError", async () => {
    const f = fakeFetch(429, { success: false, error: { code: "rate_limited", message: "slow down" } });
    const m = new PrimitiveMailer({ apiKey: "prim_test", fetch: f as unknown as typeof fetch });
    const err = await m.send({ from: "a@d", to: "b@d", subject: "s", text: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(PrimitiveSendError);
    expect(err.code).toBe("rate_limited");
    expect(isRecipientNotAllowed(err)).toBe(false);
  });
});
