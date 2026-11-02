import { defineConfig } from "vitest/config";

// The store tests share the `*_test` database with packages/db; run files one at a time.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
