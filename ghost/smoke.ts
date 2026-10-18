/**
 * Manual smoke test against the real `claude` CLI or the real Messages API (NOT a vitest test; costs ~$0.30).
 *
 *   npx tsx ghost/smoke.ts            # GHOST_RUNNER from .env (local, with Messages fallback)
 *   npx tsx ghost/smoke.ts messages   # Messages API fallback only
 *   npx tsx ghost/smoke.ts local      # local claude only, no fallback
 *
 * Uses shared/fixtures/transcript-pineapple.jsonl and a throwaway git repo under the OS temp dir.
 * Prints the answer, quotes, cost and duration. Never prints config values.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../config/index.ts";
import type { GhostRunner } from "../shared/interfaces.ts";
import { createGhostRunner, LocalRunner, MessagesRunner } from "./index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const transcript = path.join(here, "..", "shared", "fixtures", "transcript-pineapple.jsonl");
const sessionId = "c582ae8f-939d-42fe-94dd-cec74d30d65d";
const mode = process.argv[2];

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seance-smoke-")));
const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
g("init", "-q");
g("-c", "user.email=smoke@example.com", "-c", "user.name=Smoke", "commit", "-q", "--allow-empty", "-m",
  "smoke\n\nAgent-Session: s-c582ae8f@example.invalid");

const config = getConfig();
const runner: GhostRunner =
  mode === "messages" ? new MessagesRunner({ config }) : mode === "local" ? new LocalRunner({ config }) : createGhostRunner(config);

try {
  const res = await runner.run({
    session: {
      sessionId,
      shortId: "c582ae8f",
      address: "s-c582ae8f@example.invalid",
      repoPath: repo,
      transcriptPath: transcript,
      startedAt: new Date().toISOString(),
    },
    transcriptLocalPath: transcript,
    from: "smoke@example.invalid",
    question: "What word did I ask you to remember, and what happened when you tried to run the command?",
  });
  console.log(JSON.stringify(res, null, 2));
  console.log(`original transcript untouched: ${fs.existsSync(transcript)}`);
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}
