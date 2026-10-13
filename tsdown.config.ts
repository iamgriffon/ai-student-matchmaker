import { isBuiltin } from "node:module";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { server: "src/index.ts", trainMatchmaking: "scripts/trainMatchmaking.ts" },
  platform: "node",
  target: "node22.18",
  format: "esm",
  clean: true,
  hash: false,
  outExtensions: () => ({ js: ".mjs" }),
  copy: [{ from: ["public/**/*", "!public/tests/**"], to: "dist/public", flatten: false }],
  outputOptions: {
    codeSplitting: true,
  },
  deps: {
    onlyBundle: false,
    alwaysBundle: (id) => !isBuiltin(id),
  },
});
