import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signWebhookPayload } from "@primitivedotdev/sdk/webhook";
import { describe, expect, it } from "vitest";
import { normalizeInbound, parseAbout, pickRecipient, safeEqual, stripQuoted, verifyPrimitiveSignature } from "./inbound.ts";
import { OnceWithin, RateLimiter } from "./ratelimit.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(here, "..", "shared", "fixtures", `primitive-webhook-${name}.json`), "utf8")).body;
const DOMAIN = "safe-maple.primitive.email";

describe("normalizeInbound (real M0 payloads)", () => {
  it("gmail -> test@", () => {
    const m = normalizeInbound(fixture("gmail"), DOMAIN);
    expect(m.messageId).toBe("6d50cabb-d261-457a-b862-db6cc3069ac5");
    expect(m.threadId).toBe("0d634a30-30ea-b706-688d-729c5dd80ea0");
    expect(m.from).toMatch(/^[^<>\s]+@gmail\.com$/);
    expect(m.to).toBe("test@safe-maple.primitive.email");
    expect(m.subject).toBe("seance probe from gmail");
    expect(m.text).toBe("hello from gmail probe");
    expect(m.authenticated).toBe(true);
    expect(m.eventId).toMatch(/^evt_/);
  });

  it("ghost reply -> ask-probe keeps thread", () => {
    const m = normalizeInbound(fixture("reply"), DOMAIN);
    expect(m.to).toBe("ask-probe@safe-maple.primitive.email");
    expect(m.from).toBe("test@safe-maple.primitive.email");
    expect(m.threadId).toBeTruthy();
  });

  it("falls back to email.id when there is no thread_id, and throws without an id", () => {
    const evt = fixture("internal");
    delete evt.email.thread_id;
    expect(normalizeInbound(evt, DOMAIN).threadId).toBe(evt.email.id);
    expect(() => normalizeInbound({ event: "email.received", email: {} }, DOMAIN)).toThrow();
  });
});

describe("pickRecipient", () => {
  it("prefers ghost/asker local parts, then our domain", () => {
    expect(pickRecipient(["other@x.com", "Ghost <s-7f3a1b2c@d.example>"], "d.example")).toBe("s-7f3a1b2c@d.example");
    expect(pickRecipient(["other@x.com", "ask-ab12@d.example"], "d.example")).toBe("ask-ab12@d.example");
    expect(pickRecipient(["other@x.com", "hello@d.example"], "d.example")).toBe("hello@d.example");
    expect(pickRecipient(["other@x.com"], "d.example")).toBe("other@x.com");
  });
});

describe("stripQuoted", () => {
  it("drops the attribution line and everything after it", () => {
    expect(stripQuoted("Thanks, but why?\n\nOn Sun, Oct 18, 2026 at 1:09 AM Ghost <s-1@x> wrote:\n> old text\n> more")).toBe("Thanks, but why?");
  });
  it("handles an attribution wrapped over two lines", () => {
    expect(stripQuoted("new\nOn Sun, Oct 18, 2026 at 1:09 AM Someone\n<s-1@x> wrote:\n> old")).toBe("new");
  });
  it("drops > lines and signatures", () => {
    expect(stripQuoted("a\n> quoted\nb\n-- \nsig")).toBe("a\nb");
  });
});

describe("parseAbout", () => {
  it("extracts and removes the About line", () => {
    expect(parseAbout("Why 0.37?\n\nAbout: src/retry.ts:12\n")).toEqual({ question: "Why 0.37?", file: "src/retry.ts", line: 12 });
  });
  it("leaves questions without one alone", () => {
    expect(parseAbout("  just asking  ")).toEqual({ question: "just asking" });
  });
});

describe("signature + secret helpers", () => {
  it("verifies SDK-signed bodies and rejects tampering, wrong secrets and stale timestamps", () => {
    const raw = JSON.stringify({ hello: "world" });
    const { header } = signWebhookPayload(raw, "whsec_x");
    expect(verifyPrimitiveSignature(raw, header, "whsec_x")).toBe(true);
    expect(verifyPrimitiveSignature(raw + " ", header, "whsec_x")).toBe(false);
    expect(verifyPrimitiveSignature(raw, header, "whsec_y")).toBe(false);
    expect(verifyPrimitiveSignature(raw, header, undefined)).toBe(false);
    expect(verifyPrimitiveSignature(raw, undefined, "whsec_x")).toBe(false);
    const old = signWebhookPayload(raw, "whsec_x", Math.floor(Date.now() / 1000) - 3600);
    expect(verifyPrimitiveSignature(raw, old.header, "whsec_x")).toBe(false);
  });
  it("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual(undefined, "abc")).toBe(false);
    expect(safeEqual("", "")).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("allows 5/min per sender, notifies once per window, then resets", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 5; i++) expect(rl.check("a@x", 1000 + i).ok).toBe(true);
    expect(rl.check("a@x", 2000)).toEqual({ ok: false, scope: "sender", notify: true });
    expect(rl.check("a@x", 3000)).toEqual({ ok: false, scope: "sender", notify: false });
    expect(rl.check("b@x", 3000).ok).toBe(true);
    expect(rl.check("a@x", 62_000).ok).toBe(true);
  });
  it("caps 30/hour globally", () => {
    const rl = new RateLimiter();
    let t = 0;
    for (let i = 0; i < 30; i++) expect(rl.check(`u${i}@x`, (t += 1000)).ok).toBe(true);
    expect(rl.check("new@x", (t += 1000))).toEqual({ ok: false, scope: "global", notify: true });
    expect(rl.check("new@x", (t += 1000))).toEqual({ ok: false, scope: "global", notify: false });
    expect(rl.check("new@x", 3_700_000).ok).toBe(true);
  });
  it("OnceWithin", () => {
    const o = new OnceWithin(1000);
    expect(o.first("k", 0)).toBe(true);
    expect(o.first("k", 500)).toBe(false);
    expect(o.first("k", 1500)).toBe(true);
  });
});
