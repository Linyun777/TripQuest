import { defineConfig } from "vite";

export default defineConfig({
  envDir: false,
  build: {
    ssr: "apps/web/src/deployment-cli.ts",
    outDir: "deploy/dist",
    target: "node24",
    minify: false,
    rollupOptions: { output: { entryFileNames: "cli.js" } },
  },
  ssr: { noExternal: true },
});
