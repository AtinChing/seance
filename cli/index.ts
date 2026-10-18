// Entry point for `seance` (launched by cli/bin.js). Logic lives in main.ts so tests can import it.
import { runCli } from "./main.ts";

process.exitCode = await runCli(process.argv.slice(2));
