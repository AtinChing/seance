import { serve } from "@hono/node-server";
import { getConfig, requireConfig } from "../config/index.ts";
import { createGhostRunner } from "../ghost/index.ts";
import { createRegistry } from "../registry/index.ts";
import { createApp } from "./app.ts";
import { describeEvent, EventBus } from "./events.ts";
import { PrimitiveMailer, type ServerMailer } from "./mailer.ts";
import { registerTowerRoutes } from "./tower.ts";
import { registerMcpSupportRoutes } from "./mcp-support.ts";
import { registerLlmRoutes, TokenStore } from "./llm.ts";

const config = getConfig();
requireConfig(config, "primitiveDomain");

const registry = createRegistry(config);
// Per-run tokens for the /llm gateway: Blaxel sandboxes never see GHOSTS_API_KEY.
const tokens = new TokenStore();
const runner = createGhostRunner(config, { tokens });

const mailer: ServerMailer = config.primitiveApiKey
  ? new PrimitiveMailer({ apiKey: config.primitiveApiKey })
  : {
      async send() { throw new Error("PRIMITIVE_API_KEY is not set; email is disabled"); },
      async reply() { throw new Error("PRIMITIVE_API_KEY is not set; email is disabled"); },
    };

const bus = new EventBus();
bus.on((e) => console.log(`[event] ${describeEvent(e)}`));

const app = createApp({ config, registry, runner, mailer, bus });
registerTowerRoutes(app, { recentQuestions: () => app.recentQuestions(), bus, config, registry });
registerMcpSupportRoutes(app, { config, registry });
registerLlmRoutes(app, { config, tokens });

const askMode = config.raw.SEANCE_ASK_MODE === "in-process" || !config.primitiveApiKey || !config.publicUrl ? "in-process" : "email";

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `[seance] server on :${info.port} · domain ${config.primitiveDomain} · runner ${config.ghostRunner} · registry ${config.registry}` +
      ` · ask via ${askMode} · webhook secret ${config.primitiveWebhookSecret ? "set" : "missing"}` +
      ` · public ${config.publicUrl ? `${config.publicUrl}/inbound` : "missing"}`,
  );
});

process.on("unhandledRejection", (err) => {
  console.error(`[seance] unhandled rejection: ${err instanceof Error ? err.message : String(err)}`);
});
