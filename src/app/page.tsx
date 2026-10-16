import { prisma } from "@/lib/prisma";
import { HomeView, type DbStatus } from "./home-view";

// 首页每次请求都查数据库，不做静态缓存。
export const dynamic = "force-dynamic";

async function checkDatabase(): Promise<DbStatus> {
  try {
    const rows = await prisma.$queryRaw<{ version: string }[]>`SELECT version()`;
    const [stores, users] = await Promise.all([prisma.store.count(), prisma.user.count()]);
    return { ok: true, version: rows[0]?.version ?? "", stores, users };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export default async function HomePage() {
  const db = await checkDatabase();
  return <HomeView db={db} />;
}
