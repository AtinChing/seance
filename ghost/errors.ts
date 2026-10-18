/** A ghost run failed in a way the caller can recover from (e.g. by falling back to another runner). */
export class GhostError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GhostError";
  }
}

/** Replace every occurrence of each secret value with "[redacted]". Used on any text that ends up in an error. */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  return out;
}
