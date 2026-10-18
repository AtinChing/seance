import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { conversationTurns, evidenceStrings, parseTranscript, readTranscript, renderCondensed } from "./transcript.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PINEAPPLE = path.join(here, "..", "shared", "fixtures", "transcript-pineapple.jsonl");

describe("transcript reader", () => {
  it("skips malformed lines", () => {
    expect(parseTranscript('{"type":"user"}\nnot json\n\n[1]\n{"type":"x"}')).toHaveLength(2);
  });

  it("extracts only user/assistant conversation from the fixture", async () => {
    const lines = await readTranscript(PINEAPPLE);
    const turns = conversationTurns(lines);
    expect(turns.every((t) => t.role === "user" || t.role === "assistant")).toBe(true);
    const ev = evidenceStrings(lines).join("\n");
    expect(ev).toContain("Remember the word pineapple.");
    expect(ev).toContain("printenv CLAUDECODE");
    expect(ev).toContain("This command requires approval");
    expect(ev).not.toContain("mango");
    expect(ev).not.toContain("tabs for indentation");
  });

  it("renders a condensed, role-labelled view", async () => {
    const out = renderCondensed(await readTranscript(PINEAPPLE));
    expect(out).toContain("[user] Remember the word pineapple.");
    expect(out).toContain("[tool_use Bash] {\"command\":\"printenv CLAUDECODE\"");
    expect(out).toContain("[tool_result error] This command requires approval");
    expect(out).toContain('[assistant] OK. I\'ll remember "pineapple"');
    expect(out).not.toContain("mango");
  });

  it("truncates tool results and caps the whole rendering, keeping start and end", () => {
    const lines = [
      { type: "user", message: { content: "FIRST MESSAGE" } },
      { type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(5000) }] } },
      ...Array.from({ length: 50 }, (_, i) => ({ type: "assistant", message: { content: [{ type: "text", text: `msg ${i} ${"y".repeat(200)}` }] } })),
      { type: "assistant", message: { content: "LAST MESSAGE" } },
    ];
    const full = renderCondensed(lines);
    expect(full).toContain("…[3000 more chars]");
    const capped = renderCondensed(lines, { maxChars: 3000 });
    expect(capped.length).toBeLessThanOrEqual(3000);
    expect(capped.startsWith("[user] FIRST MESSAGE")).toBe(true);
    expect(capped.endsWith("[assistant] LAST MESSAGE")).toBe(true);
    expect(capped).toContain("omitted");
  });
});
