import type { Registry } from "../shared/interfaces.ts";
import { getConfig, type SeanceConfig } from "../config/index.ts";
import { JsonRegistry, type SeanceRegistry } from "./json.ts";

export { JsonRegistry } from "./json.ts";
export type { RegistryState, JsonRegistryOptions, SeanceRegistry } from "./json.ts";

let warnedInsforge = false;

/** Pick the registry backend from config (REGISTRY=json|insforge). */
export function createRegistry(config: SeanceConfig = getConfig()): SeanceRegistry {
  if (config.registry === "insforge" && !warnedInsforge) {
    warnedInsforge = true;
    console.warn("[seance registry] InsForge registry arrives in M6; using JSON");
  }
  return new JsonRegistry(config.dataDir);
}

export type { Registry };
