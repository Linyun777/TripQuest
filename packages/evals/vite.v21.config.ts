import { defineConfig } from "vite";
export default defineConfig({
  envDir: false,
  build: {
    ssr: "src/v21-cli.ts",
    outDir: "dist-v21",
    target: "node24",
    minify: false,
  },
  ssr: {
    noExternal: ["@tripquest/agent", "@tripquest/application", "@tripquest/domain", "@tripquest/providers"],
  },
});
