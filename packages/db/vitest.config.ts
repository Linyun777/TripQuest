import { defineConfig } from "vitest/config";

// Every database test file truncates the same local `tripquest_test` database in
// its own beforeEach. Vitest runs files in parallel by default, so two files
// would wipe each other's rows mid-test and produce failures that have nothing
// to do with the code under test. Serialising the files keeps the shared real
// database deterministic.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
