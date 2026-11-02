import { defineConfig } from "vite";
export default defineConfig({
  envDir: false,
  build: { ssr: "src/cli.ts", outDir: "dist", target: "node24", minify: false },
  ssr: { noExternal: ["@tripquest/domain", "@tripquest/providers"] },
});
