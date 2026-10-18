# Séance MCP server

An MCP server, built on [mcp-use](https://github.com/mcp-use/mcp-use) (from `mcp-use/starter-pack-blank`), that lets any MCP-speaking agent ask the Claude Code session that wrote a line of code why it is the way it is. It is a thin client of the Séance server: `ask_session` calls `POST /api/ask`, which emails the ghost (`ask-…@` → `s-…@`) and waits for its threaded reply, so email stays the universal interface.

## Tools

| Tool | Input | What it does |
|---|---|---|
| `ask_session` | `question`, plus `address` **or** `file` + `line` (optional `repo`) | Wakes a read-only fork of the session; returns its answer, quotes marked `✓ VERIFIED` / `? UNVERIFIED`, session, commit, duration. 30–90 s, ~$0.40 per call. 130 s client timeout. |
| `whois_line` | `file`, `line`, optional `repo` | git blame → commit → `Agent-Session` trailer. Free and fast. Without `repo`, every repo a recorded session worked in is tried. |
| `list_sessions` | none | Recorded sessions, newest first: address, repo folder, started/ended, snapshot. |

Errors come back as `isError` results with a next step for the agent: `unknown_session`, `no_session_for_line`, `timeout`, `blocked` (outbound filter withheld the reply), `unauthorized`, `unreachable`, `not_supported` (server missing `/api/sessions` or `/api/whois`).

## Config

| Env | Default | Notes |
|---|---|---|
| `SEANCE_SERVER_URL` | `http://localhost:8787` | Deployed: the public tunnel URL (`PUBLIC_URL`). |
| `SEANCE_SECRET` | from `../.env` locally | Must equal the Séance server's `SEANCE_SECRET`. |
| `SEANCE_MCP_TOKEN` | off | If set, clients must send `Authorization: Bearer <token>`. Recommended when deployed (each ask costs money). |
| `SEANCE_ENV_FILE` | `../.env` | Local fallback for the two keys above; `none` disables it. Only `SEANCE_SECRET`, `SEANCE_SERVER_URL` and `PORT` are read. |

## Run locally

```bash
cd mcp && npm install
npm run dev -- --port 3030          # MCP at http://localhost:3030/mcp, Inspector at /mcp/inspector
npx mcp-use client connect local http://localhost:3030/mcp
npx mcp-use client local tools call whois_line file=src/retry.ts line:=1
npx mcp-use client local tools call ask_session --timeout 150000 address=s-055fcb2d "question=Why is the retry delay 0.37?"
```

Unit tests run from the repo root: `npx vitest run mcp/src`.

## Deploy to Manufact (Atin)

Prereqs: the Séance server running on :8787, the cloudflared tunnel up, and `PUBLIC_URL` in the root `.env` set to the current tunnel URL (the same URL Primitive posts to). The server must include `registerMcpSupportRoutes` for `whois_line` and `list_sessions` to work (`ask_session` works without it).

```bash
cd ~/Documents/GitHub/seance/mcp
npx mcp-use login                    # once
# optional but recommended: require a bearer token from clients
#   echo "SEANCE_MCP_TOKEN=$(openssl rand -hex 24)" > .env.local   (gitignored, not uploaded)
npm run deploy:manufact              # = scripts/deploy.sh
```

`scripts/deploy.sh` takes `SEANCE_SECRET` and `PUBLIC_URL` from the root `.env` (plus `SEANCE_MCP_TOKEN` if set), writes them to a 0600 temp env file, and runs `npx mcp-use deploy . --no-github --name seance --env-file <tmp>`. Later runs redeploy the linked server (`.mcp-use/cloud/link.json`). `DRY_RUN=1 npm run deploy:manufact` checks everything without logging in or deploying. The deploy command prints the server URL; copy the exact MCP URL from its output or the Manufact dashboard (it ends in `/mcp`).

Follow the build: `npx mcp-use deployments list --server <server-id>` and `npx mcp-use deployments logs <deployment-id> --build --follow`. Smoke test: `npx mcp-use client connect prod <MCP_URL>` then `npx mcp-use client prod tools call list_sessions`.

**When the quick tunnel restarts** the URL changes. Update `PUBLIC_URL` in `.env` (and the Primitive endpoint), then re-run `npm run deploy:manufact`, or `npx mcp-use servers env set <server> SEANCE_SERVER_URL=<new url>` followed by a redeploy.

## Client config

Replace `<MCP_URL>` with the deployed URL (or `http://localhost:3030/mcp` locally). Drop the `headers` block if `SEANCE_MCP_TOKEN` is off.

**Claude Code** (one command; default scope is local to you, add `-s project` to write a shareable `.mcp.json` into the repo):

```bash
claude mcp add --transport http seance <MCP_URL> --header "Authorization: Bearer <SEANCE_MCP_TOKEN>"
```

or a JSON file for `claude --mcp-config seance-mcp.json`:

```json
{
  "mcpServers": {
    "seance": {
      "type": "http",
      "url": "<MCP_URL>",
      "headers": { "Authorization": "Bearer <SEANCE_MCP_TOKEN>" }
    }
  }
}
```

`ask_session` can take up to ~90 s; if Claude Code times out, start it with `MCP_TOOL_TIMEOUT=150000`.

**Cursor** (`~/.cursor/mcp.json` or `<repo>/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "seance": {
      "url": "<MCP_URL>",
      "headers": { "Authorization": "Bearer <SEANCE_MCP_TOKEN>" }
    }
  }
}
```

## Known limits

- Deployed, every call goes deployed MCP → cloudflared tunnel → your laptop's Séance server, so the laptop and tunnel must be up. Cloudflare quick tunnels cut responses at ~100 s (HTTP 524, reported as `timeout`); ghost answers normally take 10–60 s.
- `repo` paths are paths on the Séance server's machine. Agents elsewhere should pass `address`, or `file` + `line` and let the server search its known repos.
