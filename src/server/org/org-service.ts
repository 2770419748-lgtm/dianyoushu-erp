import "server-only";
import { prisma } from "@/lib/prisma";
import type { Role } from "@/generated/prisma/enums";
import { DEMO_PROTECTED_MESSAGE, isProtectedDemoAccount } from "@/server/auth/demo-accounts";
import { hashPassword } from "@/server/auth/password";
import { canManageOrg, ROLE_LABELS } from "@/server/auth/permissions";
import type { CurrentUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/audit";

// 组织管理服务层：区域、门店、员工的新增、编辑、停用。只有总部能调；每次写入记操作日志。
// 页面里的 Server Function 只负责把表单值传进来，规则都在这里。

export class OrgError extends Error {}

type Actor = Pick<CurrentUser, "id" | "role">;

function assertCanManage(actor: Actor): void {
  if (!canManageOrg(actor.role)) throw new OrgError("只有总部账号能管理组织");
}

function requireText(value: unknown, label: string, max = 50): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new OrgError(`${label}不能为空`);
  if (text.length > max) throw new OrgError(`${label}最多 ${max} 个字`);
  return text;
}

function optionalText(value: unknown, max = 200): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max) throw new OrgError(`最多 ${max} 个字`);
  return text || null;
}

function requireId(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new OrgError(`请选择${label}`);
  return n;
}

const ROLES = Object.keys(ROLE_LABELS) as Role[];

function requireRole(value: unknown): Role {
  if (typeof value === "string" && (ROLES as string[]).includes(value)) return value as Role;
  throw new OrgError("请选择角色");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

// ---------- 查询 ----------

export async function getOrgTree() {
  const [regions, users] = await Promise.all([
    prisma.region.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        name: true,
        isActive: true,
        stores: {
          orderBy: { code: "asc" },
          select: { id: true, code: true, name: true, address: true, regionId: true, isActive: true },
        },
      },
    }),
    prisma.user.findMany({
      orderBy: { id: "asc" },
      select: { id: true, username: true, name: true, role: true, storeId: true, regionId: true, isActive: true },
    }),
  ]);
  return { regions, users };
}

export type OrgTree = Awaited<ReturnType<typeof getOrgTree>>;
export type OrgRegion = OrgTree["regions"][number];
export type OrgStore = OrgRegion["stores"][number];
export type OrgUser = OrgTree["users"][number];

// ---------- 区域 ----------

export async function createRegion(actor: Actor, input: { name: unknown }) {
  assertCanManage(actor);
  const name = requireText(input.name, "区域名称");
  try {
    const region = await prisma.region.create({ data: { name } });
    await writeAudit({ userId: actor.id, action: "region.create", entity: "region", entityId: region.id, detail: { name } });
    return region;
  } catch (error) {
    if (isUniqueViolation(error)) throw new OrgError("已经有同名区域了");
    throw error;
  }
}

export async function updateRegion(actor: Actor, id: number, input: { name: unknown }) {
  assertCanManage(actor);
  const name = requireText(input.name, "区域名称");
  try {
    const region = await prisma.region.update({ where: { id }, data: { name } });
    await writeAudit({ userId: actor.id, action: "region.update", entity: "region", entityId: id, detail: { name } });
    return region;
  } catch (error) {
    if (isUniqueViolation(error)) throw new OrgError("已经有同名区域了");
    throw error;
  }
}

export async function setRegionActive(actor: Actor, id: number, isActive: boolean) {
  assertCanManage(actor);
  if (!isActive) {
    const activeStores = await prisma.store.count({ where: { regionId: id, isActive: true } });
    if (activeStores > 0) throw new OrgError(`这个区域下还有 ${activeStores} 家营业中的门店，先停用门店`);
  }
  const region = await prisma.region.update({ where: { id }, data: { isActive } });
  await writeAudit({ userId: actor.id, action: isActive ? "region.activate" : "region.deactivate", entity: "region", entityId: id });
  return region;
}

// ---------- 门店 ----------

export interface StoreInput {
  code: unknown;
  name: unknown;
  regionId: unknown;
  address?: unknown;
}

function parseStoreInput(input: StoreInput) {
  const code = requireText(input.code, "门店编码", 20).toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(code)) throw new OrgError("门店编码只能用字母、数字和横线，如 S001");
  return {
    code,
    name: requireText(input.name, "门店名称"),
    regionId: requireId(input.regionId, "所属区域"),
    address: optionalText(input.address),
  };
}

export async function createStore(actor: Actor, input: StoreInput) {
  assertCanManage(actor);
  const data = parseStoreInput(input);
  try {
    const store = await prisma.store.create({ data });
    await writeAudit({ userId: actor.id, action: "store.create", entity: "store", entityId: store.id, detail: data });
    return store;
  } catch (error) {
    if (isUniqueViolation(error)) throw new OrgError("门店编码已经存在");
    throw error;
  }
}

export async function updateStore(actor: Actor, id: number, input: StoreInput) {
  assertCanManage(actor);
  const data = parseStoreInput(input);
  try {
    const store = await prisma.store.update({ where: { id }, data });
    await writeAudit({ userId: actor.id, action: "store.update", entity: "store", entityId: id, detail: data });
    return store;
  } catch (error) {
    if (isUniqueViolation(error)) throw new OrgError("门店编码已经存在");
    throw error;
  }
}

export async function setStoreActive(actor: Actor, id: number, isActive: boolean) {
  assertCanManage(actor);
  if (!isActive) {
    const activeUsers = await prisma.user.count({ where: { storeId: id, isActive: true } });
    if (activeUsers > 0) throw new OrgError(`这家店还有 ${activeUsers} 个在职员工，先把员工停用或调到别的店`);
  }
  const store = await prisma.store.update({ where: { id }, data: { isActive } });
  await writeAudit({ userId: actor.id, action: isActive ? "store.activate" : "store.deactivate", entity: "store", entityId: id });
  return store;
}

// ---------- 员工 ----------

export interface UserInput {
  name: unknown;
  role: unknown;
  storeId?: unknown;
  regionId?: unknown;
}

function parseUserInput(input: UserInput) {
  const name = requireText(input.name, "姓名", 30);
  const role = requireRole(input.role);
  let storeId: number | null = null;
  let regionId: number | null = null;
  if (role === "STAFF" || role === "STORE_MANAGER") {
    storeId = requireId(input.storeId, "所属门店");
  } else if (role === "REGIONAL_MANAGER") {
    regionId = requireId(input.regionId, "所辖区域");
  }
  return { name, role, storeId, regionId };
}

function requirePassword(value: unknown): string {
  const password = typeof value === "string" ? value : "";
  if (password.length < 6) throw new OrgError("密码至少 6 位");
  if (password.length > 72) throw new OrgError("密码最多 72 位");
  return password;
}

export async function createUser(actor: Actor, input: UserInput & { username: unknown; password: unknown }) {
  assertCanManage(actor);
  const username = requireText(input.username, "登录账号", 30).toLowerCase();
  if (!/^[a-z0-9_]{3,30}$/.test(username)) throw new OrgError("登录账号只能用小写字母、数字、下划线，3 到 30 位");
  const data = parseUserInput(input);
  const passwordHash = await hashPassword(requirePassword(input.password));
  try {
    const user = await prisma.user.create({ data: { username, passwordHash, ...data } });
    await writeAudit({ userId: actor.id, action: "user.create", entity: "user", entityId: user.id, detail: { username, ...data } });
    return user;
  } catch (error) {
    if (isUniqueViolation(error)) throw new OrgError("登录账号已经存在");
    throw error;
  }
}

/** 演示账号不能被改密码、停用、改角色（见 demo-accounts.ts） */
async function assertNotDemoAccount(id: number) {
  const target = await prisma.user.findUnique({ where: { id }, select: { username: true } });
  if (target && isProtectedDemoAccount(target.username)) throw new OrgError(DEMO_PROTECTED_MESSAGE);
}

export async function updateUser(actor: Actor, id: number, input: UserInput) {
  assertCanManage(actor);
  await assertNotDemoAccount(id);
  const data = parseUserInput(input);
  if (id === actor.id && data.role !== "HQ") throw new OrgError("不能把自己改成非总部角色");
  const user = await prisma.user.update({ where: { id }, data });
  await writeAudit({ userId: actor.id, action: "user.update", entity: "user", entityId: id, detail: data });
  return user;
}

export async function resetUserPassword(actor: Actor, id: number, password: unknown) {
  assertCanManage(actor);
  await assertNotDemoAccount(id);
  const passwordHash = await hashPassword(requirePassword(password));
  // 版本号 +1：这个人之前的登录（可能在别人手里）马上失效，要用新密码重新登录
  await prisma.user.update({ where: { id }, data: { passwordHash, sessionVersion: { increment: 1 } } });
  await writeAudit({ userId: actor.id, action: "user.reset_password", entity: "user", entityId: id });
}

export async function setUserActive(actor: Actor, id: number, isActive: boolean) {
  assertCanManage(actor);
  await assertNotDemoAccount(id);
  if (id === actor.id && !isActive) throw new OrgError("不能停用自己");
  const user = await prisma.user.update({ where: { id }, data: { isActive, sessionVersion: { increment: 1 } } });
  await writeAudit({ userId: actor.id, action: isActive ? "user.activate" : "user.deactivate", entity: "user", entityId: id });
  return user;
}
