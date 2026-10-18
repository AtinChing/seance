// Settings for the MCP server. Deployed: from the platform env. Local: process env first, then only the
// few keys we need from the Séance repo's root .env (../.env from mcp/), so local runs need no setup.
// Never logs values.
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export interface McpConfig {
  serverUrl: string;
  secret?: string;
  /** If set, MCP clients must send `Authorization: Bearer <token>`. */
  accessToken?: string;
  /** Where values came from, for the startup log. */
  source: string;
}

function readRootEnv(envFile: string | undefined): Record<string, string> {
  const candidates = [envFile, path.resolve(process.cwd(), "..", ".env")].filter(Boolean) as string[];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const all = parseEnv(fs.readFileSync(file, "utf8")) as Record<string, string>;
      // Pick only what the MCP server needs; nothing else from that file is kept in memory.
      const pick: Record<string, string> = {};
      for (const k of ["SEANCE_SECRET", "SEANCESECRET", "SEANCE_SERVER_URL", "PORT"]) if (all[k]) pick[k] = all[k];
      return pick;
    } catch {
      // unreadable: fall through to defaults
    }
  }
  return {};
}

export function loadMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const needFile = !env.SEANCE_SECRET || !env.SEANCE_SERVER_URL;
  const file = needFile && env.SEANCE_ENV_FILE !== "none" ? readRootEnv(env.SEANCE_ENV_FILE) : {};
  const secret = env.SEANCE_SECRET || file.SEANCE_SECRET || file.SEANCESECRET || undefined;
  const serverUrl = (env.SEANCE_SERVER_URL || file.SEANCE_SERVER_URL || `http://localhost:${file.PORT || 8787}`).replace(/\/+$/, "");
  const fromFile = Object.keys(file).length > 0;
  return {
    serverUrl,
    secret,
    accessToken: env.SEANCE_MCP_TOKEN || undefined,
    source: fromFile ? "env + Séance root .env" : "env",
  };
}
