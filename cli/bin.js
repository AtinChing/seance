#!/usr/bin/env node
// Thin launcher so `npm link` exposes `seance` while the CLI stays in TypeScript.
import { register } from "tsx/esm/api";
register();
await import("./index.ts");
