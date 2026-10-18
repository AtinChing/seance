import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { normalizeText, quoteSegments, verifyQuotes } from "./verify.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PINEAPPLE = path.join(here, "..", "shared", "fixtures", "transcript-pineapple.jsonl");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seance-verify-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeTranscript(lines: object[]): string {
  const p = path.join(tmp, `t-${Math.random().toString(16).slice(2)}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

const user = (content: unknown) => ({ type: "user", message: { role: "user", content } });
const assistant = (content: unknown) => ({ type: "assistant", message: { role: "assistant", content } });

const synthetic = writeTranscript([
  { type: "api-request-blob", message: { role: "system", content: [{ type: "text", text: "System prompt: the deploy password is hunter2hunter2." }] } },
  { type: "attachment", attachment: { type: "environment", content: "Attachment says the retry budget is forty two." } },
  { type: "cost-state", note: "cost state mentions the magic number nine hundred" },
  user("Change the retry delay to 0.25, please."),
  assistant([
    { type: "thinking", thinking: "I should check whether 0.25 causes double charges first." },
    { type: "text", text: "I ran the experiment.  With 0.25 the  provider saw DUPLICATE charges — so I’ll keep 0.37." },
    {
      type: "tool_use",
      name: "Write",
      input: { file_path: "pay/retry.py", content: "# 0.25 caused double charges\nRETRY_BASE_DELAY = 0.37\n\ndef backoff(n):\n    return RETRY_BASE_DELAY * 2 ** n\n" },
    },
  ]),
  user([
    { type: "tool_result", tool_use_id: "t1", content: "experiment: 0.25 -> 3 double charges in 100 runs" },
    { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "pytest: 12 passed in 0.8s" }, { type: "image", source: {} }] },
  ]),
  assistant("Kept RETRY_BASE_DELAY at 0.37 after the experiment."),
]);

async function v(quote: string, file = synthetic): Promise<boolean> {
  const [r] = await verifyQuotes([quote], file);
  expect(r.text).toBe(quote);
  return r.verified;
}

describe("normalizeText and quoteSegments", () => {
  it("normalizes case, whitespace, curly quotes and dashes", () => {
    expect(normalizeText("  Hello\n\t“World” — it’s  FINE – ok ")).toBe(`hello "world" - it's fine - ok`);
    expect(normalizeText("ﬁne")).toBe("fine"); // NFKC ligature
  });
  it("strips surrounding quotes and ellipses, and splits on inner ellipses", () => {
    expect(quoteSegments(`“...I ran the experiment…”`)).toEqual(["i ran the experiment"]);
    expect(quoteSegments(`'a b c' ... "d e f" [...] g`)).toEqual(["a b c", "d e f", "g"]);
  });
});

describe("verifyQuotes", () => {
  it("verifies exact quotes from user and assistant text", async () => {
    expect(await v("Change the retry delay to 0.25, please.")).toBe(true);
    expect(await v("Kept RETRY_BASE_DELAY at 0.37 after the experiment.")).toBe(true);
  });

  it("ignores case and whitespace differences", async () => {
    expect(await v("with 0.25 the provider saw duplicate charges")).toBe(true);
    expect(await v("I   RAN the\nexperiment.")).toBe(true);
  });

  it("treats curly and straight quotes, and dashes, alike", async () => {
    expect(await v(`duplicate charges - so I'll keep 0.37`)).toBe(true);
    expect(await v(`duplicate charges – so I’ll keep 0.37`)).toBe(true);
  });

  it("strips surrounding quote marks and leading/trailing ellipses", async () => {
    expect(await v(`"…the provider saw DUPLICATE charges..."`)).toBe(true);
  });

  it("accepts ellipsis segments only in order", async () => {
    expect(await v("I ran the experiment ... so I'll keep 0.37")).toBe(true);
    expect(await v("I ran the experiment … kept RETRY_BASE_DELAY at 0.37")).toBe(true); // across messages, in order
    expect(await v("so I'll keep 0.37 ... I ran the experiment")).toBe(false);
    expect(await v("I ran the experiment ... we deployed on friday")).toBe(false);
  });

  it("rejects fabricated quotes", async () => {
    expect(await v("0.25 is perfectly safe to use in production")).toBe(false);
    expect(await v("With 0.30 the provider saw duplicate charges")).toBe(false);
  });

  it("never counts the system prompt, attachments or other line types", async () => {
    expect(await v("the deploy password is hunter2hunter2")).toBe(false);
    expect(await v("the retry budget is forty two")).toBe(false);
    expect(await v("mentions the magic number nine hundred")).toBe(false);
  });

  it("verifies tool results (string and text blocks)", async () => {
    expect(await v("0.25 -> 3 double charges in 100 runs")).toBe(true);
    expect(await v("pytest: 12 passed in 0.8s")).toBe(true);
  });

  it("verifies tool inputs, including code spanning newlines", async () => {
    expect(await v("# 0.25 caused double charges RETRY_BASE_DELAY = 0.37")).toBe(true);
    expect(await v("# 0.25 caused double charges\\nRETRY_BASE_DELAY = 0.37")).toBe(true); // JSON-escaped newline
    expect(await v("def backoff(n): return RETRY_BASE_DELAY * 2 ** n")).toBe(true);
  });

  it("verifies thinking", async () => {
    expect(await v("check whether 0.25 causes double charges")).toBe(true);
  });

  it("does not let a plain quote span two separate strings", async () => {
    expect(await v("please. I should check whether")).toBe(false);
  });

  it("never verifies quotes that are too short", async () => {
    expect(await v("0.37")).toBe(false);
    expect(await v("ran the exp")).toBe(false); // 11 chars
    expect(await v("I ran the ex")).toBe(true); // 12 chars
    expect(await v("…")).toBe(false);
    expect(await v('""')).toBe(false);
  });

  describe("on the real pineapple fixture", () => {
    it("verifies conversation quotes", async () => {
      const r = await verifyQuotes(
        [
          "Remember the word pineapple.",
          "OK. I'll remember \"pineapple\" for this conversation.",
          "printenv CLAUDECODE",
          "This command requires approval",
          "A variable in this command can't be checked before it runs",
        ],
        PINEAPPLE,
      );
      expect(r.map((q) => q.verified)).toEqual([true, true, true, true, true]);
    });

    it("rejects the synthetic system prompt and attachment", async () => {
      const r = await verifyQuotes(
        ["the secret code word is mango", "CLAUDE.md says always use tabs for indentation", "SYNTHETIC SYSTEM PROMPT for tests"],
        PINEAPPLE,
      );
      expect(r.map((q) => q.verified)).toEqual([false, false, false]);
    });
  });
});
