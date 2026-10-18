import type { GhostResult } from "../shared/types.ts";

export interface ParsedGhostOutput {
  answer: string;
  quotes: string[];
  confidence: GhostResult["confidence"];
}

const CONFIDENCE = new Set(["high", "medium", "low"]);

/** Index of the "}" matching the "{" at `start`, honouring JSON strings and escapes; -1 if unbalanced. */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The first (outermost) balanced JSON object in `text` that parses and has a string `answer`. */
function findAnswerObject(text: string): Record<string, unknown> | null {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = matchBrace(text, start);
    if (end === -1) continue;
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (obj && typeof obj === "object" && !Array.isArray(obj) && typeof obj.answer === "string") return obj;
    } catch {
      // not valid JSON from here; try the next "{"
    }
  }
  return null;
}

/**
 * Parse the ghost's reply text into {answer, quotes, confidence}. Tolerates ```json fences, leading prose and
 * trailing text. Falls back to the whole text as the answer, no quotes, confidence "low".
 */
export function parseGhostOutput(text: string): ParsedGhostOutput {
  const raw = (text ?? "").trim();
  // ```json fences and surrounding prose need no stripping: the scan finds the object wherever it sits.
  const obj = findAnswerObject(raw);
  if (!obj || !(obj.answer as string).trim()) {
    return { answer: raw || "(the ghost returned no answer)", quotes: [], confidence: "low" };
  }
  const quotes = Array.isArray(obj.quotes)
    ? obj.quotes.filter((q): q is string => typeof q === "string" && q.trim() !== "").map((q) => q.trim())
    : [];
  const conf = typeof obj.confidence === "string" ? obj.confidence.trim().toLowerCase() : "";
  return {
    answer: (obj.answer as string).trim(),
    quotes,
    confidence: CONFIDENCE.has(conf) ? (conf as ParsedGhostOutput["confidence"]) : "low",
  };
}
