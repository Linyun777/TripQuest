import { defineConfig } from "vite";
export default defineConfig({
  envDir: false,
  build: {
    ssr: "src/feedback-cli.ts",
    outDir: "dist-feedback",
    target: "node24",
    minify: false,
  },
  ssr: {
    noExternal: ["@tripquest/agent", "@tripquest/domain", "@tripquest/providers"],
  },
});
