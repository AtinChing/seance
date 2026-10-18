import fs from "node:fs";
import path from "node:path";
import { addressFor, shortIdFor } from "../shared/address.ts";
import { repoRoot } from "../shared/git.ts";
import type { SessionRecord } from "../shared/types.ts";
import { currentSessionFile, logHook, type HookContext, type HookInput, type HookResult } from "./common.ts";

/** SessionStart: register the session and mark it as the repo's current session. */
export async function sessionStart(input: HookInput, ctx: HookContext): Promise<HookResult> {
  const sessionId = input.session_id;
  if (!sessionId) throw new Error("session-start: no session_id on stdin");
  if (!ctx.config.primitiveDomain) throw new Error("session-start: PRIMITIVE_DOMAIN is not configured");
  const cwd = input.cwd || ctx.cwd;
  const repo = (await repoRoot(cwd)) ?? cwd;
  const shortId = shortIdFor(sessionId);
  const registry = await ctx.getRegistry();
  const now = (ctx.now ?? (() => new Date()))().toISOString();

  // Same session id seen again (resume / compact): keep the original start time.
  const existing = await registry.getSessionByShortId(shortId);
  const same = existing && existing.sessionId === sessionId ? existing : null;

  const record: SessionRecord = {
    ...(same ?? {}),
    sessionId,
    shortId,
    address: addressFor(shortId, ctx.config.primitiveDomain),
    repoPath: repo,
    transcriptPath: input.transcript_path || same?.transcriptPath || "",
    startedAt: same?.startedAt ?? now,
  };
  // Active again: it has not ended (an older snapshot, if any, is kept).
  delete record.endedAt;
  await registry.upsertSession(record);

  const marker = currentSessionFile(repo);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, sessionId + "\n");
  logHook(ctx.config.dataDir, "session-start", `registered ${record.address} (source=${input.source ?? "?"}) repo=${repo}`);
  return { code: 0 };
}
