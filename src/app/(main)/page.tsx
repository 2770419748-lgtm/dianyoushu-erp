import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/auth/current-user";
import { ROLE_LABELS } from "@/server/auth/permissions";
import { HomeView, type DbStatus } from "./home-view";

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
  const user = await requireUser();
  const db = await checkDatabase();
  return <HomeView db={db} greeting={`你好，${user.name}（${ROLE_LABELS[user.role]}）`} />;
}
