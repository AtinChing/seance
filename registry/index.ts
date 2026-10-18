import type { Registry } from "../shared/interfaces.ts";
import { getConfig, type SeanceConfig } from "../config/index.ts";
import { JsonRegistry, type SeanceRegistry } from "./json.ts";
import { InsForgeRegistry } from "./insforge.ts";

export { JsonRegistry } from "./json.ts";
export type { RegistryState, JsonRegistryOptions, SeanceRegistry } from "./json.ts";
export { InsForgeRegistry } from "./insforge.ts";
export type { InsForgeOptions } from "./insforge.ts";

/** Pick the registry backend from config (REGISTRY=json|insforge). */
export function createRegistry(config: SeanceConfig = getConfig()): SeanceRegistry {
  if (config.registry === "insforge") {
    const missing = [!config.insforgeUrl && "INSFORGE_URL", !config.insforgeApiKey && "INSFORGE_API_KEY"].filter(Boolean);
    if (missing.length) {
      throw new Error(`REGISTRY=insforge needs ${missing.join(" and ")} (missing). Set them in .env, or use REGISTRY=json.`);
    }
    return new InsForgeRegistry({ url: config.insforgeUrl!, apiKey: config.insforgeApiKey!, dataDir: config.dataDir });
  }
  return new JsonRegistry(config.dataDir);
}

export type { Registry };
