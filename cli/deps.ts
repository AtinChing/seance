import type { SeanceConfig } from "../config/index.ts";
import type { Registry } from "../shared/interfaces.ts";

/**
 * The one place the CLI and hooks load the real registry. Loaded lazily with a dynamic import so
 * commands that do not need it (whois, ask, init, prepare-commit-msg) never touch it, and tests
 * never import it (they pass a fake Registry instead).
 */
export async function loadRegistry(config: SeanceConfig): Promise<Registry> {
  const url = new URL("../registry/index.ts", import.meta.url).href;
  let mod: { createRegistry?: (c?: SeanceConfig) => Registry };
  try {
    mod = await import(url);
  } catch (e) {
    throw new Error(`Séance registry could not be loaded (registry/index.ts): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof mod.createRegistry !== "function") throw new Error("registry/index.ts does not export createRegistry()");
  return mod.createRegistry(config);
}
