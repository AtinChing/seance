import type { Quote } from "../shared/types.ts";

/** Sent instead of the ghost's text when the filter trips. Exact wording is part of the demo. */
export const BLOCKED_NOTICE =
  "Séance stopped this reply before it went out because it looked like it contained a secret.";

export const MAX_ANSWER_CHARS = 1500;
export const MAX_QUOTES = 3;
export const MAX_QUOTE_WORDS = 25;

interface Rule {
  name: string;
  test: (text: string) => boolean;
}

const regexRule = (name: string, re: RegExp): Rule => ({ name, test: (t) => re.test(t) });

/** Runs of base64-ish characters 40+ long that mix upper, lower and digits. */
function hasBase64Blob(text: string): boolean {
  const runs = text.match(/[A-Za-z0-9+/_-]{40,}={0,2}/g) ?? [];
  return runs.some((r) => /[A-Z]/.test(r) && /[a-z]/.test(r) && /[0-9]/.test(r));
}

/** Order matters only for which name is reported; any hit blocks. */
export const RULES: Rule[] = [
  regexRule("anthropic_key", /sk-ant-/),
  regexRule("sk_key", /\bsk-[A-Za-z0-9]{16,}/),
  regexRule("github_token", /ghp_/),
  regexRule("github_pat", /github_pat_/),
  regexRule("aws_access_key", /AKIA[0-9A-Z]{16}/),
  regexRule("pem_block", /-----BEGIN/),
  regexRule("long_hex", /[0-9a-fA-F]{48,}/),
  { name: "long_base64", test: hasBase64Blob },
];

export interface FilterInput {
  answer: string;
  quotes: Quote[];
}

export interface FilterResult {
  blocked: boolean;
  /** Names the rule that tripped, never the matched text. */
  reason?: string;
  /** What may go out: trimmed answer, or BLOCKED_NOTICE when blocked. */
  answer: string;
  /** Capped quotes, or [] when blocked. */
  quotes: Quote[];
}

/** First rule (or "env_value") that matches `text`, or null. */
export function scanText(text: string, secretValues: string[]): string | null {
  for (const r of RULES) if (r.test(text)) return r.name;
  for (const v of secretValues) if (v && text.includes(v)) return "env_value";
  return null;
}

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function trimAnswer(answer: string): string {
  if (answer.length <= MAX_ANSWER_CHARS) return answer;
  return answer.slice(0, MAX_ANSWER_CHARS - 1) + "…";
}

export function capQuotes(quotes: Quote[]): Quote[] {
  return quotes.filter((q) => wordCount(q.text) <= MAX_QUOTE_WORDS).slice(0, MAX_QUOTES);
}

/**
 * Outbound filter (spec 6.5). Scans the full answer and every quote (before trimming,
 * so nothing secret-looking slips past by sitting in a dropped quote), then trims to caps.
 */
export function filterReply(input: FilterInput, secretValues: string[]): FilterResult {
  const texts = [input.answer ?? "", ...(input.quotes ?? []).map((q) => q.text ?? "")];
  for (const [i, t] of texts.entries()) {
    const rule = scanText(t, secretValues);
    if (rule) {
      return { blocked: true, reason: `${rule} in ${i === 0 ? "answer" : `quote ${i}`}`, answer: BLOCKED_NOTICE, quotes: [] };
    }
  }
  return { blocked: false, answer: trimAnswer(input.answer ?? ""), quotes: capQuotes(input.quotes ?? []) };
}
