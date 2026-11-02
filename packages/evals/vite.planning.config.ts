import { defineConfig } from "vite";
export default defineConfig({
  envDir: false,
  build: {
    ssr: "src/planning-cli.ts",
    outDir: "dist-planning",
    target: "node24",
    minify: false,
  },
  ssr: {
    noExternal: ["@tripquest/agent", "@tripquest/application", "@tripquest/domain", "@tripquest/providers"],
  },
});
