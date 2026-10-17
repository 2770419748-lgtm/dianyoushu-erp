import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // 测试文件一个接一个跑：连库测试都用同一个本机库，并行时一个测试拿着“本店今天”的锁等库存行、
    // 另一个拿着库存行等这把锁，会被数据库判成死锁。正式代码总是先拿锁再改数据，不会这样；代价是全部测试从约 3 秒变成约 8 秒。
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
});
