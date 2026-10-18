import { existsSync } from "node:fs";
import path from "node:path";
import type { SeanceConfig } from "../config/index.ts";
import type { QuestionRecord, SessionRecord } from "../shared/types.ts";
import { JsonRegistry } from "../registry/json.ts";
import { InsForgeRegistry, KEY_PREFIX, type FetchLike } from "../registry/insforge.ts";
import { ensureSchema } from "../registry/insforge-setup.ts";
import type { Io } from "./io.ts";

/** What migrate needs from the source (the JSON registry). */
export interface MigrateSource {
  listSessions(): Promise<SessionRecord[]>;
  listQuestions(): Promise<QuestionRecord[]>;
}

/** What migrate needs from the target (InsForgeRegistry). */
export interface MigrateTarget {
  upsertSession(s: SessionRecord): Promise<void>;
  upsertQuestion(q: QuestionRecord): Promise<void>;
  uploadSnapshotIfChanged(sessionId: string, localPath: string): Promise<{ key: string; uploaded: boolean }>;
  remoteSnapshotSize(sessionId: string): Promise<number | null>;
}

export interface MigrateCounts {
  sessions: number;
  questions: number;
  snapshotsUploaded: number;
  snapshotsUnchanged: number;
  snapshotsMissing: string[]; // shortIds whose local snapshot file is gone and is not in InsForge either
}

/**
 * Copy every session, question and local snapshot file from the JSON registry into InsForge.
 * Idempotent: rows are upserted by primary key, and a snapshot already in InsForge with the same size is not re-uploaded.
 * Sessions whose snapshot was uploaded get `transcriptSnapshot = insforge:transcripts/<sessionId>.jsonl`.
 */
export async function migrateJsonToInsforge(source: MigrateSource, target: MigrateTarget, log: (s: string) => void = () => {}): Promise<MigrateCounts> {
  const counts: MigrateCounts = { sessions: 0, questions: 0, snapshotsUploaded: 0, snapshotsUnchanged: 0, snapshotsMissing: [] };

  for (const s of await source.listSessions()) {
    const rec: SessionRecord = { ...s };
    const snap = s.transcriptSnapshot;
    if (snap && !snap.startsWith(KEY_PREFIX)) {
      if (path.isAbsolute(snap) && existsSync(snap)) {
        const { key, uploaded } = await target.uploadSnapshotIfChanged(s.sessionId, snap);
        rec.transcriptSnapshot = key;
        if (uploaded) counts.snapshotsUploaded++;
        else counts.snapshotsUnchanged++;
        log(`  s-${s.shortId}: snapshot ${uploaded ? "uploaded" : "already in InsForge"}`);
      } else if ((await target.remoteSnapshotSize(s.sessionId)) !== null) {
        rec.transcriptSnapshot = `${KEY_PREFIX}transcripts/${s.sessionId}.jsonl`;
        counts.snapshotsUnchanged++;
      } else {
        counts.snapshotsMissing.push(s.shortId);
        log(`  s-${s.shortId}: snapshot file missing locally (${snap}); keeping the path as is`);
      }
    }
    await target.upsertSession(rec);
    counts.sessions++;
  }

  for (const q of await source.listQuestions()) {
    await target.upsertQuestion(q);
    counts.questions++;
  }
  return counts;
}

export interface MigrateContext {
  config: SeanceConfig;
  io: Io;
  /** Tests inject a fake fetch for the InsForge side. */
  fetch?: FetchLike;
}

/** `seance migrate`: JSON registry (<dataDir>/registry.json) -> InsForge. */
export async function migrateCommand(args: string[], ctx: MigrateContext): Promise<number> {
  const { config, io } = ctx;
  if (args.length) {
    io.err("usage: seance migrate   (copies the JSON registry into InsForge; safe to re-run)");
    return 1;
  }
  const missing = [!config.insforgeUrl && "INSFORGE_URL", !config.insforgeApiKey && "INSFORGE_API_KEY"].filter(Boolean);
  if (missing.length) {
    io.err(`Séance: seance migrate needs ${missing.join(" and ")} (missing). Set them in .env.`);
    return 1;
  }
  const source = new JsonRegistry(config.dataDir);
  const target = new InsForgeRegistry({ url: config.insforgeUrl!, apiKey: config.insforgeApiKey!, dataDir: config.dataDir, fetch: ctx.fetch });
  const host = new URL(target.http.baseUrl).host;

  io.out(`Migrating ${source.file} -> InsForge (${host})`);
  await ensureSchema(target.http, (s) => io.out(`  ${s}`));
  const c = await migrateJsonToInsforge(source, target, (s) => io.out(s));
  io.out(
    [
      `Done. sessions: ${c.sessions}, questions: ${c.questions}, snapshots: ${c.snapshotsUploaded} uploaded, ${c.snapshotsUnchanged} already there` +
        (c.snapshotsMissing.length ? `, ${c.snapshotsMissing.length} missing (${c.snapshotsMissing.map((s) => `s-${s}`).join(", ")})` : ""),
      config.registry === "insforge" ? "REGISTRY=insforge is set, so Séance now reads from InsForge." : "Set REGISTRY=insforge in .env to use it.",
    ].join("\n"),
  );
  return 0;
}
