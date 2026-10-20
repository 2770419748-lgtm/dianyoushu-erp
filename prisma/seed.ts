import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword } from "../src/server/auth/password";
import { seedProducts } from "./seed-data/products";

// 模拟数据 v0（第 12 天）：3 个区域、10 家门店、100 个员工（含 4 个固定演示账号）。
// 名字是从姓氏表和名字表里拼出来的，不是真人。随机数用固定种子，每次重置生成的数据一模一样。
// 可以反复运行：按唯一键 upsert；要彻底清空重来用 `pnpm db:reset`（prisma migrate reset，跑完自动再执行本脚本）。
// 演示密码写在 README 的"演示账号"里；真实部署前要换。

const DEMO_PASSWORD = "demo1234";

// ---------- 固定种子的随机数，保证可重复 ----------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(20261016);
const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

const SURNAMES = ["王", "李", "张", "刘", "陈", "杨", "黄", "赵", "周", "吴", "徐", "孙", "马", "朱", "胡", "郭", "何", "林", "高", "罗", "郑", "梁", "谢", "宋", "唐", "韩", "冯", "董", "程", "曹"];
const GIVEN = ["伟", "芳", "娜", "敏", "静", "丽", "强", "磊", "洋", "勇", "艳", "杰", "涛", "明", "超", "秀英", "华", "平", "刚", "桂英", "文", "婷", "浩", "欣", "雪", "佳", "宇", "晨", "阳", "琳", "鹏", "颖", "凯", "倩", "斌"];

function makeNames(count: number, taken: Set<string>): string[] {
  const names: string[] = [];
  while (names.length < count) {
    const name = pick(SURNAMES) + pick(GIVEN) + (random() < 0.35 ? pick(GIVEN).slice(0, 1) : "");
    if (taken.has(name)) continue;
    taken.add(name);
    names.push(name);
  }
  return names;
}

// ---------- 组织结构 ----------
const REGIONS = ["华东区", "华南区", "华北区"] as const;

const STORES: { code: string; name: string; region: (typeof REGIONS)[number]; address: string }[] = [
  { code: "S001", name: "中山路店", region: "华东区", address: "中山路 88 号" },
  { code: "S002", name: "人民路店", region: "华东区", address: "人民路 126 号" },
  { code: "S003", name: "解放路店", region: "华东区", address: "解放路 15 号" },
  { code: "S004", name: "建设路店", region: "华东区", address: "建设路 201 号" },
  { code: "S005", name: "文化路店", region: "华南区", address: "文化路 66 号" },
  { code: "S006", name: "新华路店", region: "华南区", address: "新华路 9 号" },
  { code: "S007", name: "和平路店", region: "华南区", address: "和平路 300 号" },
  { code: "S008", name: "胜利路店", region: "华北区", address: "胜利路 52 号" },
  { code: "S009", name: "朝阳路店", region: "华北区", address: "朝阳路 180 号" },
  { code: "S010", name: "光明路店", region: "华北区", address: "光明路 23 号" },
];

const TOTAL_USERS = 100;

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  // 区域
  const regionIds = new Map<string, number>();
  for (const name of REGIONS) {
    const region = await prisma.region.upsert({ where: { name }, update: { isActive: true }, create: { name } });
    regionIds.set(name, region.id);
  }

  // 门店
  const storeIds = new Map<string, number>();
  for (const s of STORES) {
    const regionId = regionIds.get(s.region)!;
    const store = await prisma.store.upsert({
      where: { code: s.code },
      update: { name: s.name, regionId, address: s.address, isActive: true },
      create: { code: s.code, name: s.name, regionId, address: s.address },
    });
    storeIds.set(s.code, store.id);
  }

  // 员工：先是 4 个固定演示账号，再生成其余的
  type UserSeed = { username: string; name: string; role: "HQ" | "REGIONAL_MANAGER" | "STORE_MANAGER" | "STAFF"; storeId: number | null; regionId: number | null };
  const users: UserSeed[] = [
    { username: "hq", name: "总部管理员", role: "HQ", storeId: null, regionId: null },
    { username: "regional", name: "赵经理", role: "REGIONAL_MANAGER", storeId: null, regionId: regionIds.get("华东区")! },
    { username: "manager", name: "王店长", role: "STORE_MANAGER", storeId: storeIds.get("S001")!, regionId: null },
    { username: "staff", name: "李店员", role: "STAFF", storeId: storeIds.get("S001")!, regionId: null },
  ];

  const taken = new Set(users.map((u) => u.name));
  let seq = 1;
  const nextUsername = () => `emp${String(seq++).padStart(3, "0")}`;

  // 其余两个区域各一个区域经理
  for (const regionName of REGIONS.slice(1)) {
    users.push({ username: nextUsername(), name: makeNames(1, taken)[0]!, role: "REGIONAL_MANAGER", storeId: null, regionId: regionIds.get(regionName)! });
  }
  // S002 到 S010 各一个店长
  for (const s of STORES.slice(1)) {
    users.push({ username: nextUsername(), name: makeNames(1, taken)[0]!, role: "STORE_MANAGER", storeId: storeIds.get(s.code)!, regionId: null });
  }
  // 剩下的全是店员，轮流分到 10 家店
  const staffCount = TOTAL_USERS - users.length;
  const staffNames = makeNames(staffCount, taken);
  staffNames.forEach((name, i) => {
    const store = STORES[i % STORES.length]!;
    users.push({ username: nextUsername(), name, role: "STAFF", storeId: storeIds.get(store.code)!, regionId: null });
  });

  for (const u of users) {
    await prisma.user.upsert({
      where: { username: u.username },
      update: { name: u.name, role: u.role, storeId: u.storeId, regionId: u.regionId, passwordHash, isActive: true },
      create: { ...u, passwordHash },
    });
  }

  // 商品主数据：50 个机型 + 30 个配件
  const products = await seedProducts(prisma);

  const counts = {
    regions: await prisma.region.count(),
    stores: await prisma.store.count(),
    users: await prisma.user.count(),
  };
  console.log(
    `种子数据完成：区域 ${counts.regions}、门店 ${counts.stores}、员工 ${counts.users}；机型 ${products.deviceModels}、配件 ${products.accessories}、服务 ${products.services}、SKU ${products.skus}（演示账号 hq / regional / manager / staff，密码见 README）`,
  );
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
