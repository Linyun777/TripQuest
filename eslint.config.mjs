import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    settings: {
      next: { rootDir: "apps/web/" },
    },
  },
  globalIgnores(["**/.next/**", "packages/evals/dist/**", "packages/evals/dist-agent/**", "packages/evals/dist-feedback/**", "packages/evals/dist-planning/**", "packages/evals/dist-v21/**", "apps/worker/dist/**", "packages/rag/dist/**", "packages/auth/dist/**", "**/out/**", "**/build/**", "**/next-env.d.ts"]),
]);
