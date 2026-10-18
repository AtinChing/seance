/**
 * Idempotent InsForge schema setup for the Séance registry (SPEC 6.8).
 *
 *   npx tsx registry/insforge-setup.ts
 *
 * Creates (only what is missing):
 *   - table `sessions`  (PK session_id, index on short_id)
 *   - table `questions` (PK id, indexes on thread_id, session_short_id, created_at; `result` is jsonb)
 *   - private storage bucket `transcripts`
 * Uses INSFORGE_URL + INSFORGE_API_KEY from config. Never prints the key.
 */
import { pathToFileURL } from "node:url";
import { getConfig, type SeanceConfig } from "../config/index.ts";
import { InsForgeHttp, QUESTIONS_TABLE, SESSIONS_TABLE, TRANSCRIPTS_BUCKET } from "./insforge.ts";

/** Columns per table (all text unless noted). Timestamps are kept as the ISO strings the app writes, so records round-trip exactly. */
export const SCHEMA: Record<string, [string, string][]> = {
  [SESSIONS_TABLE]: [
    ["session_id", "text"],
    ["short_id", "text"],
    ["address", "text"],
    ["repo_path", "text"],
    ["transcript_path", "text"],
    ["transcript_snapshot", "text"],
    ["started_at", "text"],
    ["ended_at", "text"],
  ],
  [QUESTIONS_TABLE]: [
    ["id", "text"],
    ["session_short_id", "text"],
    ["from_address", "text"],
    ["question", "text"],
    ["file", "text"],
    ["line", "integer"],
    ["thread_id", "text"],
    ["status", "text"],
    ["result", "jsonb"],
    ["blocked_reason", "text"],
    ["created_at", "text"],
    ["answered_at", "text"],
  ],
};

/** Every statement is IF NOT EXISTS, so re-running it is harmless. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS public.${SESSIONS_TABLE} (
  session_id text PRIMARY KEY
);
${SCHEMA[SESSIONS_TABLE].filter(([c]) => c !== "session_id").map(([c, t]) => `ALTER TABLE public.${SESSIONS_TABLE} ADD COLUMN IF NOT EXISTS ${c} ${t};`).join("\n")}
CREATE INDEX IF NOT EXISTS ${SESSIONS_TABLE}_short_id_idx ON public.${SESSIONS_TABLE} (short_id);
ALTER TABLE public.${SESSIONS_TABLE} ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.${QUESTIONS_TABLE} (
  id text PRIMARY KEY
);
${SCHEMA[QUESTIONS_TABLE].filter(([c]) => c !== "id").map(([c, t]) => `ALTER TABLE public.${QUESTIONS_TABLE} ADD COLUMN IF NOT EXISTS ${c} ${t};`).join("\n")}
CREATE INDEX IF NOT EXISTS ${QUESTIONS_TABLE}_thread_id_idx ON public.${QUESTIONS_TABLE} (thread_id);
CREATE INDEX IF NOT EXISTS ${QUESTIONS_TABLE}_session_short_id_idx ON public.${QUESTIONS_TABLE} (session_short_id);
CREATE INDEX IF NOT EXISTS ${QUESTIONS_TABLE}_created_at_idx ON public.${QUESTIONS_TABLE} (created_at);
ALTER TABLE public.${QUESTIONS_TABLE} ENABLE ROW LEVEL SECURITY;
`.trim();

const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHmmss

/** Column names of a table, or null if the schema endpoint gives an unexpected shape. */
async function tableColumns(http: InsForgeHttp, table: string): Promise<Set<string> | null> {
  const s = await http.json<{ columns?: { columnName?: string; name?: string }[] }>("GET", `/api/database/tables/${table}/schema`);
  if (!s || !Array.isArray(s.columns)) return null;
  return new Set(s.columns.map((c) => c.columnName ?? c.name ?? "").filter(Boolean));
}

export interface SetupResult {
  migrated: boolean;
  migrationVersion?: string;
  bucket: "created" | "made-private" | "ok";
  tables: string[];
}

export async function ensureSchema(http: InsForgeHttp, log: (s: string) => void = () => {}): Promise<SetupResult> {
  // 1. tables: run the (idempotent) migration only if a table or column is missing.
  const tables = (await http.json<string[]>("GET", "/api/database/tables")) ?? [];
  const missing: string[] = [];
  for (const [table, cols] of Object.entries(SCHEMA)) {
    if (!tables.includes(table)) {
      missing.push(table);
      continue;
    }
    const have = await tableColumns(http, table).catch(() => null);
    const lacking = have ? cols.map(([c]) => c).filter((c) => !have.has(c)) : [];
    if (lacking.length) missing.push(`${table}(${lacking.join(", ")})`);
  }

  const result: SetupResult = { migrated: false, bucket: "ok", tables: [] };
  if (missing.length) {
    const { migrations = [] } = (await http.json<{ migrations?: { version: string; name: string }[] }>("GET", "/api/database/migrations")) ?? {};
    let version = stamp(new Date());
    const latest = migrations.map((m) => BigInt(m.version)).reduce((a, b) => (b > a ? b : a), 0n);
    if (BigInt(version) <= latest) version = String(latest + 1n);
    log(`Creating/upgrading: ${missing.join(", ")} (migration ${version})`);
    await http.json("POST", "/api/database/migrations", {
      json: { version, name: "seance-registry", sql: SCHEMA_SQL },
      timeoutMs: 30_000,
    });
    result.migrated = true;
    result.migrationVersion = version;
  } else {
    log("Tables sessions and questions already exist with every column.");
  }

  // 2. private bucket for transcript snapshots.
  const buckets = (await http.json<{ name: string; public: boolean }[]>("GET", "/api/storage/buckets")) ?? [];
  const b = buckets.find((x) => x.name === TRANSCRIPTS_BUCKET);
  if (!b) {
    await http.json("POST", "/api/storage/buckets", { json: { bucketName: TRANSCRIPTS_BUCKET, isPublic: false } });
    result.bucket = "created";
    log(`Created private bucket ${TRANSCRIPTS_BUCKET}.`);
  } else if (b.public) {
    await http.json("PATCH", `/api/storage/buckets/${TRANSCRIPTS_BUCKET}`, { json: { isPublic: false } });
    result.bucket = "made-private";
    log(`Bucket ${TRANSCRIPTS_BUCKET} was public; made it private.`);
  } else {
    log(`Bucket ${TRANSCRIPTS_BUCKET} already exists (private).`);
  }

  // 3. verify.
  const after = (await http.json<string[]>("GET", "/api/database/tables")) ?? [];
  result.tables = Object.keys(SCHEMA).filter((t) => after.includes(t));
  const absent = Object.keys(SCHEMA).filter((t) => !after.includes(t));
  if (absent.length) throw new Error(`InsForge setup: tables still missing after migration: ${absent.join(", ")}`);
  return result;
}

export function httpFromConfig(config: SeanceConfig = getConfig()): InsForgeHttp {
  const missing = [!config.insforgeUrl && "INSFORGE_URL", !config.insforgeApiKey && "INSFORGE_API_KEY"].filter(Boolean);
  if (missing.length) throw new Error(`InsForge is not configured: set ${missing.join(" and ")} in .env`);
  return new InsForgeHttp({ url: config.insforgeUrl!, apiKey: config.insforgeApiKey! });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const http = httpFromConfig();
  console.log(`InsForge setup against ${new URL(http.baseUrl).host}`);
  ensureSchema(http, (s) => console.log(`  ${s}`))
    .then((r) => {
      console.log(`Done. tables: ${r.tables.join(", ")}; bucket ${TRANSCRIPTS_BUCKET}: ${r.bucket}${r.migrated ? `; migration ${r.migrationVersion} applied` : ""}`);
    })
    .catch((e) => {
      console.error(`InsForge setup failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
