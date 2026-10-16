import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword } from "../src/server/auth/password";

// 演示种子数据：1 个区域、2 家门店、4 个角色各一个账号。可以反复运行（按唯一键 upsert）。
// 演示密码写在 README 的"演示账号"里；真实部署前要换。
const DEMO_PASSWORD = "demo1234";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const region = await prisma.region.upsert({
    where: { name: "华东区" },
    update: {},
    create: { name: "华东区" },
  });

  const store1 = await prisma.store.upsert({
    where: { code: "S001" },
    update: { name: "示范一店", regionId: region.id },
    create: { code: "S001", name: "示范一店", regionId: region.id, address: "示范路 1 号" },
  });
  await prisma.store.upsert({
    where: { code: "S002" },
    update: { name: "示范二店", regionId: region.id },
    create: { code: "S002", name: "示范二店", regionId: region.id, address: "示范路 2 号" },
  });

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const users = [
    { username: "hq", name: "总部管理员", role: "HQ" as const, storeId: null, regionId: null },
    { username: "regional", name: "赵经理", role: "REGIONAL_MANAGER" as const, storeId: null, regionId: region.id },
    { username: "manager", name: "王店长", role: "STORE_MANAGER" as const, storeId: store1.id, regionId: null },
    { username: "staff", name: "李店员", role: "STAFF" as const, storeId: store1.id, regionId: null },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { username: u.username },
      update: { name: u.name, role: u.role, storeId: u.storeId, regionId: u.regionId, passwordHash, isActive: true },
      create: { ...u, passwordHash },
    });
  }

  console.log(`种子数据完成：区域 1、门店 2、账号 ${users.length}（密码见 README 演示账号）`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
