import { defineConfig } from "vite";

// The owner's CLI (pnpm users) as one Node entry with its workspace packages, like the worker.
export default defineConfig({
  envDir: false,
  build: {
    ssr: "src/cli.ts",
    outDir: "dist",
    target: "node24",
    minify: false,
    rollupOptions: { output: { entryFileNames: "users.js" } },
  },
  ssr: { noExternal: true },
});
