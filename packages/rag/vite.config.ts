import { defineConfig } from "vite";

// Bundles the RAG commands and their workspace packages into one Node entry, like the worker.
export default defineConfig({
  envDir: false,
  build: {
    ssr: "src/cli.ts",
    outDir: "dist",
    target: "node24",
    minify: false,
  },
  ssr: { noExternal: true },
});
