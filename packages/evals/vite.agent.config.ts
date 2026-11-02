import { defineConfig } from "vite";
export default defineConfig({
  envDir: false,
  build: {
    ssr: "src/agent-cli.ts",
    outDir: "dist-agent",
    target: "node24",
    minify: false,
  },
  ssr: {
    noExternal: ["@tripquest/agent", "@tripquest/domain", "@tripquest/providers"],
  },
});
