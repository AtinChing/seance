import { describe, expect, it } from "vitest";
import { formatReply } from "./format.ts";

const base = { answer: "0.25 double charges.", quotes: [{ text: "baseDelay=0.25s charges=2", verified: true }], shortId: "055fcb2d", commit: "28f1f6458bdf", durationMs: 30_400 };

describe("formatReply", () => {
  it("keeps the local-runner footer unchanged", () => {
    const text = formatReply(base);
    expect(text).toContain("answered by a disposable fork in 30s");
    expect(text).not.toContain("re-ran the tests");
  });
  it("adds the sandbox test re-run and a sandbox footer in blaxel mode", () => {
    const text = formatReply({ ...base, runner: "blaxel", testOutput: "\n> test\n✔ a customer is charged exactly once\n\n(npm test exited 0)" });
    expect(text).toContain("The ghost re-ran the tests in its sandbox:");
    expect(text).toContain("  ✔ a customer is charged exactly once");
    expect(text).toContain("answered by a disposable fork in a throwaway sandbox in 30s");
    expect(text.indexOf("re-ran the tests")).toBeGreaterThan(text.indexOf("Evidence from"));
  });
  it("keeps only the last 12 lines of test output", () => {
    const out = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const text = formatReply({ ...base, runner: "blaxel", testOutput: out });
    expect(text).toContain("line 29");
    expect(text).not.toContain("line 17\n");
  });
});
