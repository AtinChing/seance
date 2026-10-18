import type { Quote } from "../shared/types.ts";
import { evidenceStrings, readTranscript } from "./transcript.ts";

/** Quotes shorter than this (normalized, ellipses removed) are never verified: too easy to match by chance. */
export const MIN_QUOTE_CHARS = 12;

/** Separator between evidence strings: never produced by normalization, so a plain quote cannot span two strings. */
const SEP = "\u0000";

/** NFKC, curly quotes to straight, dashes to "-", lowercase, collapse whitespace, trim. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const EDGE_QUOTES = /^[\s"'`]+|[\s"'`]+$/g;

function stripEdges(s: string): string {
  let prev: string;
  let cur = s;
  do {
    prev = cur;
    cur = cur.replace(EDGE_QUOTES, "").replace(/^\.{3,}|\.{3,}$/g, "");
  } while (cur !== prev);
  return cur;
}

/**
 * Normalized segments of a quote: surrounding quote marks and leading/trailing ellipses removed, then split on
 * any inner ellipsis ("...", "…" which NFKC turns into "...", or "[...]").
 */
export function quoteSegments(quote: string): string[] {
  const q = stripEdges(normalizeText(quote).replace(/\[\s*\.{3,}\s*\]/g, "..."));
  return q
    .split(/\.{3,}/)
    .map(stripEdges)
    .filter(Boolean);
}

/** Literal backslash escapes a model may copy out of JSON (\n, \t, \", \\) turned back into characters. */
function unescapeJson(s: string): string {
  return s.replace(/\\(["\\nrt])/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[c] ?? c);
}

/** True if every segment occurs in the corpus, in order. A single segment must sit inside one evidence string. */
function matchesInOrder(corpus: string, segments: string[]): boolean {
  let pos = 0;
  for (const seg of segments) {
    const i = corpus.indexOf(seg, pos);
    if (i === -1) return false;
    pos = i + seg.length;
  }
  return true;
}

/** Normalized evidence corpus from transcript evidence strings. */
export function buildCorpus(evidence: string[]): string {
  return SEP + evidence.map(normalizeText).join(SEP) + SEP;
}

export function verifyQuoteInCorpus(quote: string, corpus: string): boolean {
  const variants = new Set([quote, unescapeJson(quote)]);
  for (const v of variants) {
    const segs = quoteSegments(v);
    if (!segs.length || segs.join("").length < MIN_QUOTE_CHARS) continue;
    if (matchesInOrder(corpus, segs)) return true;
  }
  return false;
}

/**
 * Check each quote against the ORIGINAL transcript's conversation text (user and assistant messages, thinking,
 * tool inputs and tool results). System prompt, attachments and other line types never count.
 */
export async function verifyQuotes(quotes: string[], transcriptPath: string): Promise<Quote[]> {
  const corpus = buildCorpus(evidenceStrings(await readTranscript(transcriptPath)));
  return quotes.map((text) => ({ text, verified: verifyQuoteInCorpus(text, corpus) }));
}
