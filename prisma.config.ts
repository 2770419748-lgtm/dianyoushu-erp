import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma 7：数据库连接串不再写在 schema.prisma 里，而是在这里从 .env 读。
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
