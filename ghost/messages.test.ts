import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/index.ts";
import type { SessionRecord } from "../shared/types.ts";
import { GhostError } from "./errors.ts";
import { createGhostRunner, FallbackRunner } from "./index.ts";
import { MessagesRunner, type MessagesClient } from "./messages.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PINEAPPLE = path.join(here, "..", "shared", "fixtures", "transcript-pineapple.jsonl");
const FAKE_KEY = "test-ghosts-key-not-real-0123456789";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "seance-msg-"));
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const cfg = (extra: Record<string, string> = {}) =>
  loadConfig({ envFile: null, env: { GHOSTS_API_KEY: FAKE_KEY, SEANCE_DATA_DIR: dataDir, ...extra } });

const session: SessionRecord = {
  sessionId: "c582ae8f-939d-42fe-94dd-cec74d30d65d",
  shortId: "c582ae8f",
  address: "s-c582ae8f@x.example",
  repoPath: dataDir,
  transcriptPath: PINEAPPLE,
  startedAt: "2026-10-18T08:08:09Z",
};
const input = { session, transcriptLocalPath: PINEAPPLE, question: "What word?", from: "judge@example.com" };

const reply = JSON.stringify({ answer: "Pineapple.", quotes: ["Remember the word pineapple.", "invented words here"], confidence: "high" });

function mockClient(text = reply) {
  const create = vi.fn(async (_params: any) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }));
  const keys: string[] = [];
  const createClient = (apiKey: string): MessagesClient => {
    keys.push(apiKey);
    return { messages: { create } };
  };
  return { create, createClient, keys };
}

describe("MessagesRunner", () => {
  it("sends the condensed transcript and prompt with the ghost key, then parses and verifies", async () => {
    const m = mockClient();
    const res = await new MessagesRunner({ config: cfg(), createClient: m.createClient, log: () => {} }).run(input);
    expect(m.keys).toEqual([FAKE_KEY]);
    const params = m.create.mock.calls[0][0];
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.max_tokens).toBe(1500);
    const content: string = params.messages[0].content;
    expect(content).toContain("<earlier_conversation>");
    expect(content).toContain("[user] Remember the word pineapple.");
    expect(content).not.toContain("mango");
    expect(content).toContain("Question: What word?");
    expect(content.trimEnd().endsWith('"confidence": "high|medium|low"}')).toBe(true);
    expect(res).toMatchObject({
      answer: "Pineapple.",
      confidence: "high",
      runner: "local",
      quotes: [
        { text: "Remember the word pineapple.", verified: true },
        { text: "invented words here", verified: false },
      ],
    });
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("honours SEANCE_FALLBACK_MODEL", async () => {
    const m = mockClient();
    await new MessagesRunner({ config: cfg({ SEANCE_FALLBACK_MODEL: "claude-haiku-x" }), createClient: m.createClient, log: () => {} }).run(input);
    expect(m.create.mock.calls[0][0].model).toBe("claude-haiku-x");
  });

  it("wraps API failures in GhostError without leaking the key", async () => {
    const createClient = (): MessagesClient => ({
      messages: { create: async () => { throw new Error(`401 bad key ${FAKE_KEY}`); } },
    });
    const err = await new MessagesRunner({ config: cfg(), createClient, log: () => {} }).run(input).catch((e) => e);
    expect(err).toBeInstanceOf(GhostError);
    expect(err.message).not.toContain(FAKE_KEY);
  });
});

describe("createGhostRunner", () => {
  it("local: falls back to the Messages API when the local runner fails", async () => {
    const m = mockClient();
    const logs: string[] = [];
    const runner = createGhostRunner(cfg({ GHOST_RUNNER: "local" }), {
      local: { claudeBin: path.join(dataDir, "no-such-claude"), tmpRoot: path.join(dataDir, "runs") },
      messages: { createClient: m.createClient },
      log: (l) => logs.push(l),
    });
    expect(runner).toBeInstanceOf(FallbackRunner);
    const res = await runner.run(input);
    expect(res.answer).toBe("Pineapple.");
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes("falling back to the Messages API"))).toBe(true);
    expect(logs.some((l) => l.includes("answered via Messages API fallback"))).toBe(true);
  });

  it("local: does not call the fallback when the local runner succeeds", async () => {
    const m = mockClient();
    const primary = { run: vi.fn(async () => ({ answer: "a", quotes: [], confidence: "low" as const, runId: "r", runner: "local" as const, durationMs: 1 })) };
    const fallback = new MessagesRunner({ config: cfg(), createClient: m.createClient, log: () => {} });
    await new FallbackRunner(primary, fallback, () => {}).run(input);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("local: rethrows non-GhostErrors", async () => {
    const primary = { run: async () => { throw new TypeError("bug"); } };
    const fallback = { run: vi.fn() };
    await expect(new FallbackRunner(primary, fallback as any, () => {}).run(input)).rejects.toThrow(TypeError);
    expect(fallback.run).not.toHaveBeenCalled();
  });

  it("messages: uses only the Messages runner", () => {
    expect(createGhostRunner(cfg({ GHOST_RUNNER: "messages" }))).toBeInstanceOf(MessagesRunner);
  });

  it("blaxel: not yet", () => {
    expect(() => createGhostRunner(cfg({ GHOST_RUNNER: "blaxel" }))).toThrow("blaxel runner arrives in M5");
  });
});
