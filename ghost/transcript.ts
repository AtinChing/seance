import fs from "node:fs/promises";

/** One parsed JSONL line of a Claude Code transcript. */
export type TranscriptLine = Record<string, any>;

export interface Part {
  kind: "text" | "thinking" | "tool_use" | "tool_result";
  /** Human-readable text of the part (tool_use: JSON of the input). */
  text: string;
  /** tool_use: the tool name. */
  name?: string;
  /** tool_use: every string value inside the input, recursively. */
  strings?: string[];
  /** tool_result: whether the tool reported an error. */
  isError?: boolean;
}

export interface Turn {
  role: "user" | "assistant";
  parts: Part[];
}

/** Parse JSONL text, skipping blank or malformed lines. */
export function parseTranscript(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const row of text.split("\n")) {
    if (!row.trim()) continue;
    try {
      const v = JSON.parse(row);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v);
    } catch {
      // skip a torn or partial line
    }
  }
  return out;
}

export async function readTranscript(path: string): Promise<TranscriptLine[]> {
  return parseTranscript(await fs.readFile(path, "utf8"));
}

/** Every string value inside a JSON value, depth first. */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/**
 * The conversation only: lines with type "user" or "assistant". Everything else (api-request-blob with the
 * system prompt, attachments, cost-state, queue-operation, ...) is ignored.
 */
export function conversationTurns(lines: TranscriptLine[]): Turn[] {
  const turns: Turn[] = [];
  for (const line of lines) {
    if (line.type !== "user" && line.type !== "assistant") continue;
    const content = line.message?.content;
    const parts: Part[] = [];
    if (typeof content === "string") {
      parts.push({ kind: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string") parts.push({ kind: "text", text: b.text });
        else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking)
          parts.push({ kind: "thinking", text: b.thinking });
        else if (b.type === "tool_use")
          parts.push({
            kind: "tool_use",
            name: typeof b.name === "string" ? b.name : "tool",
            text: JSON.stringify(b.input ?? {}),
            strings: collectStrings(b.input),
          });
        else if (b.type === "tool_result")
          parts.push({ kind: "tool_result", text: toolResultText(b.content), isError: b.is_error === true });
      }
    }
    if (parts.length) turns.push({ role: line.type, parts });
  }
  return turns;
}

/** The decoded strings that count as evidence for quote verification. */
export function evidenceStrings(lines: TranscriptLine[]): string[] {
  const out: string[] = [];
  for (const t of conversationTurns(lines))
    for (const p of t.parts) {
      if (p.kind === "tool_use") out.push(...(p.strings ?? []));
      else if (p.text) out.push(p.text);
    }
  return out;
}

export interface RenderOptions {
  maxChars?: number;        // whole rendering cap (default 150k)
  toolResultChars?: number; // per tool result (default 2000)
  toolInputChars?: number;  // per tool call input (default 1500)
  thinkingChars?: number;   // per thinking block (default 2000)
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)} …[${s.length - n} more chars]`;
}

/**
 * Condensed, role-labelled rendering of the conversation for the Messages API fallback. When over the cap,
 * keeps the start and the most recent part with an omission marker between them.
 */
export function renderCondensed(lines: TranscriptLine[], opts: RenderOptions = {}): string {
  const { maxChars = 150_000, toolResultChars = 2000, toolInputChars = 1500, thinkingChars = 2000 } = opts;
  const chunks: string[] = [];
  for (const t of conversationTurns(lines)) {
    for (const p of t.parts) {
      if (p.kind === "text") chunks.push(`[${t.role}] ${p.text}`);
      else if (p.kind === "thinking") chunks.push(`[${t.role} thinking] ${clip(p.text, thinkingChars)}`);
      else if (p.kind === "tool_use") chunks.push(`[tool_use ${p.name}] ${clip(p.text, toolInputChars)}`);
      else chunks.push(`[tool_result${p.isError ? " error" : ""}] ${clip(p.text, toolResultChars)}`);
    }
  }
  const text = chunks.join("\n\n");
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - 100); // room for the marker
  const marker = `\n\n[... ${text.length - budget} chars of the middle of the conversation omitted ...]\n\n`;
  const head = Math.floor(budget * 0.3);
  return text.slice(0, head) + marker + text.slice(text.length - (budget - head));
}
