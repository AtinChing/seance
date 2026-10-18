#!/usr/bin/env bash
# Deploy the Séance MCP server to Manufact in one command (after `npx mcp-use login`):
#   cd mcp && npm run deploy:manufact            # extra flags pass through to `mcp-use deploy`
#   DRY_RUN=1 npm run deploy:manufact            # check the env without logging in or deploying
#
# The deployed server needs two values from the Séance root .env:
#   SEANCE_SECRET     -> sent as x-seance-secret to the Séance server
#   PUBLIC_URL        -> becomes SEANCE_SERVER_URL (the cloudflared tunnel to your local :8787)
# Optional: SEANCE_MCP_TOKEN (shell env, or mcp/.env.local) makes MCP clients send `Authorization: Bearer <token>`.
# Values go into a 0600 temp file passed with --env-file and deleted on exit. Nothing secret is printed.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT_ENV="${SEANCE_ENV_FILE:-../.env}"
[ -f "$ROOT_ENV" ] || { echo "Séance .env not found at $ROOT_ENV (set SEANCE_ENV_FILE)" >&2; exit 1; }

if [ -z "${DRY_RUN:-}" ] && ! npx --no-install mcp-use whoami >/dev/null 2>&1; then
  echo "Not logged in to Manufact. Run: npx mcp-use login   (then re-run this)" >&2
  exit 1
fi

# mcp-use wants a relative --env-file inside the project. Its upload skips any file named .env*, and
# .env.* is also gitignored here, so this temp file is never part of the deployed source.
TMP="$(mktemp .env.deploy.XXXXXX)"
chmod 600 "$TMP"
trap 'rm -f "$TMP"' EXIT

node --input-type=module - "$ROOT_ENV" "$TMP" <<'JS'
import fs from "node:fs";
import { parseEnv } from "node:util";
const [rootEnv, out] = process.argv.slice(2);
const root = parseEnv(fs.readFileSync(rootEnv, "utf8"));
const local = fs.existsSync(".env.local") ? parseEnv(fs.readFileSync(".env.local", "utf8")) : {};
const secret = root.SEANCE_SECRET || root.SEANCESECRET;
const url = (process.env.SEANCE_SERVER_URL_DEPLOY || root.PUBLIC_URL || "").replace(/\/+$/, "");
const token = process.env.SEANCE_MCP_TOKEN || local.SEANCE_MCP_TOKEN || "";
if (!secret) { console.error("SEANCE_SECRET is missing from the Séance .env"); process.exit(1); }
if (!/^https:\/\//.test(url)) { console.error("PUBLIC_URL in the Séance .env must be the https tunnel URL (or set SEANCE_SERVER_URL_DEPLOY)"); process.exit(1); }
const lines = [`SEANCE_SECRET=${secret}`, `SEANCE_SERVER_URL=${url}`, `SEANCE_ENV_FILE=none`];
if (token) lines.push(`SEANCE_MCP_TOKEN=${token}`);
fs.writeFileSync(out, lines.join("\n") + "\n", { mode: 0o600 });
console.log(`Deploying with SEANCE_SERVER_URL=${url} · SEANCE_SECRET set · MCP token ${token ? "required" : "off"}`);
JS

# Fail early if the tunnel isn't serving the Séance server.
URL="$(grep '^SEANCE_SERVER_URL=' "$TMP" | cut -d= -f2-)"
if ! curl -fsS --max-time 10 "$URL/healthz" >/dev/null; then
  echo "Warning: $URL/healthz did not answer. Is the tunnel up and PUBLIC_URL current? Deploying anyway." >&2
fi

if [ -n "${DRY_RUN:-}" ]; then
  echo "DRY_RUN: env file has keys: $(cut -d= -f1 "$TMP" | tr '\n' ' ')"
  echo "DRY_RUN: would run: npx mcp-use deploy . $([ -f .mcp-use/cloud/link.json ] || echo '--no-github --name seance ')--env-file <tmp> $*"
elif [ -f .mcp-use/cloud/link.json ]; then
  npx --no-install mcp-use deploy . --env-file "$TMP" "$@"
else
  npx --no-install mcp-use deploy . --no-github --name seance --env-file "$TMP" "$@"
fi
