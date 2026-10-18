import type { Quote } from "../shared/types.ts";

export interface ReplyParts {
  answer: string;
  quotes: Quote[];
  shortId: string;
  commit?: string | null;
  durationMs: number;
  runner?: "local" | "blaxel";
  testOutput?: string;       // blaxel mode: tail of the ghost's `npm test` re-run (already secret-scanned)
}

/** Reply body in the spec 6.5 format. Quotes must already be filtered/capped. */
export function formatReply(p: ReplyParts): string {
  const lines: string[] = [p.answer.trim(), ""];
  if (p.quotes.length) {
    lines.push(`Evidence from session s-${p.shortId}'s own history:`);
    for (const q of p.quotes) {
      lines.push(q.verified ? `  ✓ "${q.text}"` : `  ? "${q.text}" (unverified)`);
    }
    lines.push("");
  }
  if (p.testOutput?.trim()) {
    lines.push("The ghost re-ran the tests in its sandbox:");
    for (const l of p.testOutput.trim().split("\n").slice(-12)) lines.push(`  ${l}`);
    lines.push("");
  }
  const secs = Math.max(0, Math.round(p.durationMs / 1000));
  const footer = [`Session s-${p.shortId}`];
  if (p.commit) footer.push(`commit ${p.commit.slice(0, 7)}`);
  footer.push(`answered by a disposable fork${p.runner === "blaxel" ? " in a throwaway sandbox" : ""} in ${secs}s`);
  lines.push(footer.join(" · "));
  lines.push("The original session was not modified.");
  return lines.join("\n");
}

export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

export const NOTICES = {
  notApproved: "This session only answers approved senders right now.",
  unknownSession: "No session with that address.",
  rateLimitedSender: "You're sending questions faster than this session can answer. Please wait a minute and try again.",
  rateLimitedGlobal: "Séance is answering a lot of questions right now. Please try again in a little while.",
  apology: "Sorry, this session couldn't answer your question right now. Please try again later.",
} as const;
