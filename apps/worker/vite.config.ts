import { defineConfig } from "vite";

// Bundles the worker and its workspace packages into one Node entry, like the evals CLIs.
export default defineConfig({
  envDir: false,
  build: {
    ssr: "src/worker.ts",
    outDir: "dist",
    target: "node24",
    minify: false,
  },
  ssr: { noExternal: true },
});
