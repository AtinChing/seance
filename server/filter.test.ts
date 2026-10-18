import { describe, expect, it } from "vitest";
import { secretValues } from "../config/index.ts";
import { BLOCKED_NOTICE, capQuotes, filterReply, MAX_ANSWER_CHARS, scanText, trimAnswer } from "./filter.ts";
import { formatReply } from "./format.ts";
import { testConfig } from "./test-helpers.ts";

const q = (text: string, verified = true) => ({ text, verified });

describe("outbound filter: secret rules", () => {
  const cases: Array<[string, string]> = [
    ["anthropic_key", "the key was sk-ant-api03-xyz"],
    ["sk_key", "use sk-abcdefghijklmnop1234 here"],
    ["github_token", "token ghp_aaaa"],
    ["github_pat", "github_pat_11ABCDEFG"],
    ["aws_access_key", "AKIAABCDEFGHIJKLMNOP is the id"],
    ["pem_block", "-----BEGIN RSA PRIVATE KEY-----"],
    ["long_hex", `hash ${"a1".repeat(24)} end`],
    ["long_base64", "blob QWxhZGRpbjpvcGVuIHNlc2FtZQ9xYz1234567890Abc end"],
  ];
  for (const [rule, text] of cases) {
    it(`blocks ${rule}`, () => {
      expect(scanText(text, [])).toBe(rule);
      const r = filterReply({ answer: text, quotes: [] }, []);
      expect(r.blocked).toBe(true);
      expect(r.answer).toBe(BLOCKED_NOTICE);
      expect(r.quotes).toEqual([]);
      expect(r.reason).toContain(rule);
    });
  }

  it("blocks an exact .env value, and names the rule, not the secret", () => {
    const config = testConfig({ INSFORGE_API_KEY: "plainlookingvalue" });
    const r = filterReply({ answer: "sure: plainlookingvalue", quotes: [] }, secretValues(config));
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("env_value in answer");
    expect(r.reason).not.toContain("plainlookingvalue");
  });

  it("scans quotes too, including ones the caps would drop", () => {
    const long = `${"word ".repeat(30)}sk-ant-oops`;
    const r = filterReply({ answer: "fine", quotes: [q("ok"), q(long)] }, []);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("anthropic_key in quote 2");
  });

  it("does not flag a 40-char git sha, short hex or normal prose", () => {
    const prose = "I picked RETRY_BASE_DELAY = 0.37 after commit 1c233fa4b2d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5 because 0.25 caused double charges. See src/retry.ts and https://docs.primitive.dev/docs/sending for details.";
    expect(scanText(prose, [])).toBeNull();
    expect(filterReply({ answer: prose, quotes: [q("delay 0.25: 2 charges")] }, []).blocked).toBe(false);
    expect(scanText("ask-1a2b3c4d5e@example.primitive.email s-7f3a1b2c@example.primitive.email", [])).toBeNull();
    expect(scanText("risk-taking and task-based skills", [])).toBeNull();
  });
});

describe("outbound filter: caps trim instead of blocking", () => {
  it("truncates long answers to 1500 chars with an ellipsis", () => {
    const r = filterReply({ answer: "x ".repeat(2000), quotes: [] }, []);
    expect(r.blocked).toBe(false);
    expect(r.answer.length).toBe(MAX_ANSWER_CHARS);
    expect(r.answer.endsWith("…")).toBe(true);
    expect(trimAnswer("short")).toBe("short");
  });

  it("keeps at most 3 quotes and drops ones over 25 words", () => {
    const quotes = [q("one"), q("w ".repeat(26).trim()), q("two"), q("three"), q("four")];
    expect(capQuotes(quotes).map((x) => x.text)).toEqual(["one", "two", "three"]);
    expect(capQuotes([q("w ".repeat(25).trim())])).toHaveLength(1);
  });
});

describe("reply format", () => {
  it("matches spec 6.5", () => {
    const text = formatReply({
      answer: "0.25 caused double charges.",
      quotes: [q("delay 0.25: 2 charges"), q("maybe", false)],
      shortId: "7f3a1b2c",
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      durationMs: 12_400,
    });
    expect(text).toBe([
      "0.25 caused double charges.",
      "",
      "Evidence from session s-7f3a1b2c's own history:",
      '  ✓ "delay 0.25: 2 charges"',
      '  ? "maybe" (unverified)',
      "",
      "Session s-7f3a1b2c · commit abcdef0 · answered by a disposable fork in 12s",
      "The original session was not modified.",
    ].join("\n"));
  });

  it("omits the evidence block without quotes and the commit when unknown", () => {
    const text = formatReply({ answer: "I don't know.", quotes: [], shortId: "7f3a1b2c", commit: null, durationMs: 900 });
    expect(text).toBe("I don't know.\n\nSession s-7f3a1b2c · answered by a disposable fork in 1s\nThe original session was not modified.");
  });
});
