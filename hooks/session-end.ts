import fs from "node:fs";
import { addressFor, shortIdFor } from "../shared/address.ts";
import { repoRoot } from "../shared/git.ts";
import type { Registry } from "../shared/interfaces.ts";
import type { SessionRecord } from "../shared/types.ts";
import { currentSessionFile, logHook, readCurrentSession, type HookContext, type HookInput, type HookResult } from "./common.ts";

/** Freeze the transcript and mark the session ended. Shared by the hook and `seance snapshot`. */
export async function snapshotSession(
  registry: Registry,
  base: SessionRecord,
  transcriptPath: string,
  now: Date,
): Promise<SessionRecord> {
  if (!transcriptPath) throw new Error(`no transcript path known for session ${base.shortId}`);
  if (!fs.existsSync(transcriptPath)) throw new Error(`transcript not found for session ${base.shortId}: ${transcriptPath}`);
  const key = await registry.saveTranscriptSnapshot(base.sessionId, transcriptPath);
  const record: SessionRecord = {
    ...base,
    transcriptPath: base.transcriptPath || transcriptPath,
    transcriptSnapshot: key,
    endedAt: base.endedAt ?? now.toISOString(),
  };
  await registry.upsertSession(record);
  return record;
}

/** SessionEnd: snapshot the transcript, set endedAt, clear current-session if it is ours. */
export async function sessionEnd(input: HookInput, ctx: HookContext): Promise<HookResult> {
  const sessionId = input.session_id;
  if (!sessionId) throw new Error("session-end: no session_id on stdin");
  const cwd = input.cwd || ctx.cwd;
  const shortId = shortIdFor(sessionId);
  const now = (ctx.now ?? (() => new Date()))();

  // Clear current-session first, so a later failure cannot leave commits stamped with an ended session.
  const existingRepo = (await repoRoot(cwd)) ?? cwd;
  const registry = await ctx.getRegistry();
  const existing = await registry.getSessionByShortId(shortId);
  const same = existing && existing.sessionId === sessionId ? existing : null;
  for (const repo of new Set([existingRepo, same?.repoPath].filter(Boolean) as string[])) {
    if (readCurrentSession(repo) === sessionId) fs.rmSync(currentSessionFile(repo), { force: true });
  }

  const base: SessionRecord = same ?? {
    sessionId,
    shortId,
    address: addressFor(shortId, ctx.config.primitiveDomain),
    repoPath: existingRepo,
    transcriptPath: input.transcript_path || "",
    startedAt: now.toISOString(),
  };
  const rec = await snapshotSession(registry, base, input.transcript_path || base.transcriptPath, now);
  logHook(ctx.config.dataDir, "session-end", `snapshot saved for ${rec.address} (reason=${input.reason ?? "?"})`);
  return { code: 0 };
}
