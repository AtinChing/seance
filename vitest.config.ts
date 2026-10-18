import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "demo/payments-repo/**", "demo/**/node_modules/**", "mcp/**/node_modules/**", ".seance/**"],
    testTimeout: 20000,
  },
});
