import { randomUUID } from "node:crypto";
import type { Mailer } from "../shared/interfaces.ts";

/** The shared Mailer plus a threaded reply to a stored inbound email. */
export interface ServerMailer extends Mailer {
  reply?(inboundEmailId: string, text: string, opts?: ReplyOptions): Promise<{ messageId: string; threadId: string }>;
}

export interface ReplyOptions {
  /** From override. Primitive defaults it to the inbound's recipient (the ghost address). */
  from?: string;
  idempotencyKey?: string;
}

export interface PrimitiveGate {
  name?: string;
  reason?: string;
  message?: string;
  subject?: string;
}

/** Any non-2xx from Primitive. `code` is Primitive's error code (branch on it, not the message). */
export class PrimitiveSendError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | undefined) {
    super(message);
    this.name = "PrimitiveSendError";
  }
}

/** 403 recipient_not_allowed: the account may not send to this recipient (see STATUS.md M0). */
export class RecipientNotAllowedError extends PrimitiveSendError {
  constructor(message: string, readonly gates: PrimitiveGate[]) {
    super(message, 403, "recipient_not_allowed");
    this.name = "RecipientNotAllowedError";
  }
}

export function isRecipientNotAllowed(err: unknown): err is RecipientNotAllowedError {
  return err instanceof RecipientNotAllowedError || (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "recipient_not_allowed");
}

export interface PrimitiveMailerOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Primitive REST mailer (docs: /docs/sending).
 *   send  -> POST /v1/send-mail          { from, to, subject, body_text, in_reply_to? }
 *   reply -> POST /v1/emails/{id}/reply  { body_text, from? }  (To, Re: subject, threading derived server-side)
 * Every call carries an explicit random Idempotency-Key, because keyless sends dedupe
 * identical content for 5 minutes and a second keyless reply to one inbound is suppressed.
 */
export class PrimitiveMailer implements ServerMailer {
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(private opts: PrimitiveMailerOptions) {
    if (!opts.apiKey) throw new Error("PrimitiveMailer needs PRIMITIVE_API_KEY");
    this.baseUrl = (opts.baseUrl ?? "https://api.primitive.dev/v1").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async send(input: { from: string; to: string; subject: string; text: string; inReplyTo?: string; threadId?: string }): Promise<{ messageId: string; threadId: string }> {
    const body: Record<string, unknown> = { from: input.from, to: input.to, subject: input.subject, body_text: input.text };
    // in_reply_to must be an RFC Message-ID; ignore Primitive email ids passed by mistake.
    if (input.inReplyTo && input.inReplyTo.includes("@")) body.in_reply_to = input.inReplyTo;
    const data = await this.post("/send-mail", body, randomUUID());
    return { messageId: String(data.id), threadId: input.threadId ?? String(data.id) };
  }

  async reply(inboundEmailId: string, text: string, opts: ReplyOptions = {}): Promise<{ messageId: string; threadId: string }> {
    const body: Record<string, unknown> = { body_text: text };
    if (opts.from) body.from = opts.from;
    const data = await this.post(`/emails/${encodeURIComponent(inboundEmailId)}/reply`, body, opts.idempotencyKey ?? randomUUID());
    return { messageId: String(data.id), threadId: inboundEmailId };
  }

  private async post(path: string, body: Record<string, unknown>, idempotencyKey: string): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    let json: { success?: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string; gates?: PrimitiveGate[] } } = {};
    try {
      json = (await res.json()) as typeof json;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok || json.success === false) {
      const code = json.error?.code;
      const msg = json.error?.message ?? `Primitive ${path} failed with HTTP ${res.status}`;
      if (res.status === 403 && code === "recipient_not_allowed") throw new RecipientNotAllowedError(msg, json.error?.gates ?? []);
      throw new PrimitiveSendError(msg, res.status, code);
    }
    return json.data ?? {};
  }
}
