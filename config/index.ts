import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

/** Root of the Séance checkout (where .env lives), independent of the caller's cwd. */
export const SEANCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Canonical name -> accepted aliases. */
const ALIASES: Record<string, string[]> = {
  PRIMITIVE_API_KEY: ["PRIMITIVEAPIKEY"],
  GHOSTS_API_KEY: ["GHOSTSAPIKEY"],
  INSFORGE_API_KEY: ["INSFORGEAPIKEY"],
  PRIMITIVE_WEBHOOK_SECRET: ["PRIMITIVEWEBHOOKSECRET"],
  SEANCE_SECRET: ["SEANCESECRET"],
};

/** Keys whose values are secrets: never logged, and scanned for by the outbound filter. */
const SECRET_KEYS = [
  "PRIMITIVE_API_KEY", "GHOSTS_API_KEY", "INSFORGE_API_KEY", "PRIMITIVE_WEBHOOK_SECRET", "SEANCE_SECRET",
];

export interface SeanceConfig {
  primitiveApiKey?: string;
  primitiveWebhookSecret?: string;   // verifies Primitive-Signature on /inbound
  ghostsApiKey?: string;             // ghost child processes / gateway ONLY
  insforgeUrl?: string;
  insforgeApiKey?: string;
  primitiveDomain: string;
  seanceSecret?: string;             // X-Seance-Secret between CLI/MCP and server
  allowedSenders: string[];          // lowercased
  ghostRunner: "local" | "blaxel" | "messages";
  registry: "json" | "insforge";
  publicUrl?: string;
  port: number;
  serverUrl: string;                 // where the CLI reaches the server (local by default)
  dataDir: string;                   // central Séance state: registry, transcripts, ghost homes
  debug: boolean;
  /** Raw normalized env, for the outbound filter's exact-match scan. */
  raw: Record<string, string>;
}

export function normalizeEnv(input: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) out[k] = v;
  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    if (out[canonical]) continue;
    for (const a of aliases) if (out[a]) { out[canonical] = out[a]; break; }
  }
  return out;
}

export interface LoadOptions {
  /** Path to .env. Defaults to <SEANCE_ROOT>/.env. Pass null to skip reading a file. */
  envFile?: string | null;
  /** Extra values layered over the file (process.env by default). */
  env?: Record<string, string | undefined>;
}

export function loadConfig(opts: LoadOptions = {}): SeanceConfig {
  const envFile = opts.envFile === undefined ? path.join(SEANCE_ROOT, ".env") : opts.envFile;
  const fromFile = envFile && fs.existsSync(envFile) ? parse(fs.readFileSync(envFile)) : {};
  // The process env wins over the file, so one-off overrides like GHOST_RUNNER=blaxel work.
  // ANTHROPIC_API_KEY is never read: only ghost child processes ever get one.
  const merged = normalizeEnv({ ...fromFile, ...(opts.env ?? process.env) });
  delete merged.ANTHROPIC_API_KEY;

  const port = Number(merged.PORT || 8787);
  const runner = (merged.GHOST_RUNNER || "local") as SeanceConfig["ghostRunner"];
  if (!["local", "blaxel", "messages"].includes(runner)) throw new Error(`GHOST_RUNNER must be local, blaxel or messages (got "${runner}")`);
  const registry = (merged.REGISTRY || "json") as SeanceConfig["registry"];
  if (!["json", "insforge"].includes(registry)) throw new Error(`REGISTRY must be json or insforge (got "${registry}")`);

  return {
    primitiveApiKey: merged.PRIMITIVE_API_KEY || undefined,
    primitiveWebhookSecret: merged.PRIMITIVE_WEBHOOK_SECRET || undefined,
    ghostsApiKey: merged.GHOSTS_API_KEY || undefined,
    insforgeUrl: merged.INSFORGE_URL || undefined,
    insforgeApiKey: merged.INSFORGE_API_KEY || undefined,
    primitiveDomain: merged.PRIMITIVE_DOMAIN || "",
    seanceSecret: merged.SEANCE_SECRET || undefined,
    allowedSenders: (merged.ALLOWED_SENDERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    ghostRunner: runner,
    registry,
    publicUrl: (merged.PUBLIC_URL || "").replace(/\/+$/, "") || undefined,
    port,
    serverUrl: (merged.SEANCE_SERVER_URL || `http://localhost:${port}`).replace(/\/+$/, ""),
    dataDir: merged.SEANCE_DATA_DIR || path.join(SEANCE_ROOT, ".seance"),
    debug: merged.SEANCE_DEBUG === "1",
    raw: merged,
  };
}

let cached: SeanceConfig | null = null;

export function getConfig(): SeanceConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** For tests: replace or clear the cached config. */
export function setConfig(c: SeanceConfig | null): void {
  cached = c;
}

type RequirableKey = Exclude<keyof SeanceConfig, "raw">;

/** Throws a clear error naming the missing settings (never their values). */
export function requireConfig<K extends RequirableKey>(c: SeanceConfig, ...keys: K[]): void {
  const missing = keys.filter((k) => {
    const v = c[k];
    return v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  });
  if (missing.length) throw new Error(`Séance config missing: ${missing.join(", ")} (set them in ${path.join(SEANCE_ROOT, ".env")})`);
}

/** Every secret value in the env (length >= 8), for the outbound filter's exact-match check. */
export function secretValues(c: SeanceConfig = getConfig()): string[] {
  const vals = new Set<string>();
  for (const [k, v] of Object.entries(c.raw)) {
    if (!v || v.length < 8) continue;
    if (SECRET_KEYS.includes(k) || /KEY|SECRET|TOKEN|PASSWORD/i.test(k)) vals.add(v);
  }
  return [...vals];
}

/** Safe summary for logs: which settings are present, never their values. */
export function describeConfig(c: SeanceConfig = getConfig()): Record<string, string> {
  const present = (v: unknown) => (v ? "set" : "missing");
  return {
    PRIMITIVE_API_KEY: present(c.primitiveApiKey),
    PRIMITIVE_WEBHOOK_SECRET: present(c.primitiveWebhookSecret),
    GHOSTS_API_KEY: present(c.ghostsApiKey),
    INSFORGE_API_KEY: present(c.insforgeApiKey),
    SEANCE_SECRET: present(c.seanceSecret),
    PRIMITIVE_DOMAIN: c.primitiveDomain || "missing",
    GHOST_RUNNER: c.ghostRunner,
    REGISTRY: c.registry,
    PUBLIC_URL: c.publicUrl || "missing",
    ALLOWED_SENDERS: `${c.allowedSenders.length} address(es)`,
  };
}
