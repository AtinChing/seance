import type { GhostResult, Quote } from "./types.ts";

/** Header carrying SEANCE_SECRET between CLI/MCP and the server. */
export const SECRET_HEADER = "x-seance-secret";

/** POST /api/ask body. Either `address`, or `repo`+`file`+`line` (server resolves via shared/git whoisLine). */
export interface AskRequest {
  address?: string;
  repo?: string;           // absolute repo path
  file?: string;           // repo-relative
  line?: number;
  question: string;
  timeoutMs?: number;      // default 120000
}

export type AskErrorCode = "bad_request" | "unauthorized" | "unknown_session" | "no_session_for_line" | "timeout" | "internal";

export type AskResponse =
  | {
      ok: true;
      questionId: string;
      address: string;
      shortId: string;
      answer: string;            // the ghost answer, or the blocked notice when blocked
      quotes: Quote[];
      confidence: GhostResult["confidence"];
      runner: GhostResult["runner"];
      durationMs: number;
      commit?: string;
      blocked: boolean;
      blockedReason?: string;
      via: "email" | "in-process";
    }
  | { ok: false; code: AskErrorCode; error: string };

/**
 * Cross-folder entry points (each owned by its folder's subagent):
 *   registry/index.ts  export function createRegistry(config?: SeanceConfig): Registry
 *   ghost/index.ts     export function createGhostRunner(config?: SeanceConfig): GhostRunner
 *   ghost/verify.ts    export function verifyQuotes(quotes: string[], transcriptPath: string): Promise<Quote[]>
 *   server/app.ts      export function createApp(deps): Hono   (deps injectable for tests)
 *   cli/index.ts       the `seance` CLI (launched by cli/bin.js)
 */
export {};
