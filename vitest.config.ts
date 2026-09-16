import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Một database thử dùng chung: chạy tuần tự để các ca không giẫm lên nhau.
    fileParallelism: false,
    pool: "forks",
    testTimeout: 30000,
    hookTimeout: 60000,
    globalSetup: ["tests/global-setup.ts"],
  },
});
