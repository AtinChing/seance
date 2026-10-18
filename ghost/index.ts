import { getConfig, type SeanceConfig } from "../config/index.ts";
import type { GhostRunner } from "../shared/interfaces.ts";
import type { GhostResult } from "../shared/types.ts";
import { BlaxelRunner, type BlaxelRunnerOptions, type RunTokenIssuer } from "./blaxel.ts";
import { GhostError } from "./errors.ts";
import { LocalRunner, type GhostRunInput, type LocalRunnerOptions } from "./local.ts";
import { MessagesRunner, type MessagesRunnerOptions } from "./messages.ts";

export { GhostError } from "./errors.ts";
export { LocalRunner, encodeCwd, type LocalRunnerOptions } from "./local.ts";
export { MessagesRunner, type MessagesRunnerOptions } from "./messages.ts";
export { BlaxelRunner, blaxelCredentialProblem, type BlaxelRunnerOptions, type BlaxelSdk, type RunTokenIssuer } from "./blaxel.ts";
export { verifyQuotes } from "./verify.ts";
export { buildGhostPrompt } from "./prompt.ts";

/** Tries the primary runner; on a GhostError, logs why and asks the fallback instead. */
export class FallbackRunner implements GhostRunner {
  constructor(
    private readonly primary: GhostRunner,
    private readonly fallback: GhostRunner,
    private readonly log: (msg: string) => void = (m) => console.error(`[ghost] ${m}`),
    private readonly primaryName = "local",
  ) {}

  async run(input: GhostRunInput): Promise<GhostResult> {
    try {
      return await this.primary.run(input);
    } catch (e) {
      if (!(e instanceof GhostError)) throw e;
      this.log(`${this.primaryName} runner failed, falling back to the Messages API: ${e.message}`);
      return this.fallback.run(input);
    }
  }
}

export interface GhostRunnerOptions {
  local?: Omit<LocalRunnerOptions, "config">;
  messages?: Omit<MessagesRunnerOptions, "config">;
  blaxel?: Omit<BlaxelRunnerOptions, "config" | "tokens">;
  /** The server's gateway TokenStore (server/llm.ts). Required for GHOST_RUNNER=blaxel. */
  tokens?: RunTokenIssuer;
  log?: (msg: string) => void;
}

export function createGhostRunner(config: SeanceConfig = getConfig(), opts: GhostRunnerOptions = {}): GhostRunner {
  const messages = () => new MessagesRunner({ log: opts.log, ...opts.messages, config });
  switch (config.ghostRunner) {
    case "local":
      return new FallbackRunner(new LocalRunner({ log: opts.log, ...opts.local, config }), messages(), opts.log);
    case "messages":
      return messages();
    case "blaxel": {
      if (!opts.tokens)
        throw new Error("GHOST_RUNNER=blaxel needs the server's gateway TokenStore: createGhostRunner(config, { tokens })");
      // Throws a clear error naming BL_WORKSPACE / BL_API_KEY, PUBLIC_URL or GHOSTS_API_KEY when missing.
      const blaxel = new BlaxelRunner({ log: opts.log, ...opts.blaxel, config, tokens: opts.tokens });
      // Safety net: the Messages API runner also keeps the key on the server and has no tools at all.
      return new FallbackRunner(blaxel, messages(), opts.log, "blaxel");
    }
    default:
      throw new Error(`unknown ghost runner: ${String(config.ghostRunner)}`);
  }
}
