import { timingSafeEqual, createHash } from "node:crypto";
import { verifyWebhookSignature, PRIMITIVE_SIGNATURE_HEADER } from "@primitivedotdev/sdk/webhook";
import { extractEmail, isAskerAddress, isGhostAddress } from "../shared/address.ts";
import type { InboundEmail } from "../shared/types.ts";

export { PRIMITIVE_SIGNATURE_HEADER };

/** InboundEmail plus Primitive facts that are not part of the shared contract. */
export interface InboundMessage extends InboundEmail {
  /** Primitive's analysis.sender.authenticated (DMARC-aligned etc.). */
  authenticated: boolean;
  /** Top-level webhook event id (evt_…), for dedupe. */
  eventId?: string;
}

/** Constant-time string compare (hashes first so lengths never leak). */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** True if `signatureHeader` is a valid Primitive-Signature over `rawBody` (SDK helper, 300 s tolerance). */
export function verifyPrimitiveSignature(rawBody: string, signatureHeader: string | undefined, secret: string | undefined, nowSeconds?: number): boolean {
  if (!signatureHeader || !secret) return false;
  try {
    return verifyWebhookSignature({ rawBody, signatureHeader, secret, nowSeconds }) === true;
  } catch {
    return false;
  }
}

/**
 * Strip quoted reply text: drop everything from an "On … wrote:" attribution
 * (which mail clients may wrap over two lines) or a signature/forward marker onward,
 * and drop lines starting with ">".
 */
export function stripQuoted(text: string): string {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (/^On\b.*\bwrote:\s*$/i.test(t)) break;
    if (/^On\b/i.test(t) && i + 1 < lines.length && /\bwrote:\s*$/i.test(lines[i + 1].trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(t)) break;
    if (line === "-- " || t === "--") break;
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

function asList(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v.flatMap((x) => (typeof x === "string" ? [x] : x && typeof x === "object" && typeof (x as { address?: unknown }).address === "string" ? [(x as { address: string }).address] : []));
  }
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function domainOf(addr: string): string {
  const e = extractEmail(addr);
  return e.slice(e.lastIndexOf("@") + 1);
}

/** Pick our recipient: prefer ghost/asker local parts, then anything on our domain, then the first one. */
export function pickRecipient(candidates: string[], domain: string): string {
  const emails = candidates.map(extractEmail).filter((e) => e.includes("@"));
  return (
    emails.find((e) => isGhostAddress(e) || isAskerAddress(e)) ??
    emails.find((e) => domain && domainOf(e) === domain.toLowerCase()) ??
    emails[0] ??
    ""
  );
}

/** Minimal shape of the Primitive `email.received` event fields we read. */
interface PrimitiveEmail {
  id?: string;
  thread_id?: string | null;
  received_at?: string;
  headers?: { subject?: string; from?: string; to?: string };
  smtp?: { rcpt_to?: string[]; mail_from?: string };
  parsed?: { body_text?: string | null; to_addresses?: Array<{ address: string }> | null };
  analysis?: { sender?: { authenticated?: boolean } };
}

export interface PrimitiveEvent {
  id?: string;
  event?: string;
  email?: PrimitiveEmail;
}

/** Normalize a Primitive email.received payload. Throws if it has no email id. */
export function normalizeInbound(evt: PrimitiveEvent, domain: string): InboundMessage {
  const e = evt.email;
  if (!e || !e.id) throw new Error("email.received payload has no email.id");
  const to = pickRecipient(
    [...asList(e.smtp?.rcpt_to), ...asList(e.parsed?.to_addresses), ...asList(e.headers?.to)],
    domain,
  );
  return {
    messageId: e.id,
    threadId: e.thread_id || e.id,
    from: extractEmail(e.headers?.from || e.smtp?.mail_from || ""),
    to,
    subject: e.headers?.subject ?? "",
    text: stripQuoted(e.parsed?.body_text ?? ""),
    receivedAt: e.received_at ?? new Date().toISOString(),
    authenticated: e.analysis?.sender?.authenticated === true,
    eventId: evt.id,
  };
}

/** Pull an optional `About: <file>:<line>` line out of a question body. */
export function parseAbout(text: string): { question: string; file?: string; line?: number } {
  const re = /^[ \t]*About:[ \t]*(\S(?:.*\S)?):(\d+)[ \t]*$/im;
  const m = text.match(re);
  if (!m) return { question: text.trim() };
  return { question: text.replace(re, "").replace(/\n{3,}/g, "\n\n").trim(), file: m[1], line: Number(m[2]) };
}
