import "server-only";
import { cancelPendingOaFor } from "@/server/approval/approval-service";
import { pruneNoticeNotifications } from "@/server/notice/notice-service";
import { removeFutureShiftsFor } from "@/server/hr/schedule-service";
import { todayBizDate } from "@/server/stock/doc-no";
import { prisma } from "@/lib/prisma";
import type { Role } from "@/generated/prisma/enums";
import { DEMO_PROTECTED_MESSAGE, isProtectedDemoAccount } from "@/server/auth/demo-accounts";
import { hashPassword } from "@/server/auth/password";
import { canManageOrg, ROLE_LABELS } from "@/server/auth/permissions";
import type { CurrentUser } from "@/server/auth/current-user";
import { getWecomClient, WecomError } from "@/server/wecom/client";
import { WECOM_USERID_PATTERN, wecomMode } from "@/server/wecom/config";
import { writeAudit } from "@/server/audit";
import { type Db, withTx } from "@/server/db-tx";
import { isWecomWebhookUrl } from "@/lib/alerts";
import { cancelResignedTransfersFor, createResignedTransfers, WecomTransferError } from "@/server/wecom/transfer-service";

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

export async function getOrgTree(actor: Actor) {
  assertCanManage(actor);
  const [regions, users] = await Promise.all([
    prisma.region.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        name: true,
        isActive: true,
        stores: {
          orderBy: { code: "asc" },
          select: { id: true, code: true, name: true, address: true, regionId: true, isActive: true, wecomWebhookUrl: true },
        },
      },
    }),
    prisma.user.findMany({
      orderBy: { id: "asc" },
      select: { id: true, username: true, name: true, role: true, storeId: true, regionId: true, isActive: true, wecomUserid: true, _count: { select: { wecomFollows: { where: { status: "ACTIVE" } } } } },
    }),
  ]);
  // activeFollows：跟进中的企业微信客户数，停用时提示安排接手人（口径第 12 节第三步）
  // 群机器人地址带密钥，不发到浏览器，只说有没有填
  return {
    regions: regions.map((r) => ({ ...r, stores: r.stores.map(({ wecomWebhookUrl, ...s }) => ({ ...s, hasWebhook: wecomWebhookUrl !== null })) })),
    users: users.map(({ _count, ...u }) => ({ ...u, activeFollows: _count.wecomFollows })),
  };
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
  /** 企业微信门店群机器人地址（口径第 18 节）：不填 = 不改（新建就是没有），填“无” = 清掉 */
  wecomWebhookUrl?: unknown;
}

/** 群机器人地址：undefined 表示不改 */
function parseWebhook(raw: unknown): string | null | undefined {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return undefined;
  if (text === "无") return null;
  if (!isWecomWebhookUrl(text)) throw new OrgError("群机器人地址不对：在企业微信群里添加机器人后复制它的 Webhook 地址（https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…）");
  return text;
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
  const webhook = parseWebhook(input.wecomWebhookUrl);
  try {
    const store = await prisma.store.create({ data: { ...data, wecomWebhookUrl: webhook ?? null } });
    await writeAudit({ userId: actor.id, action: "store.create", entity: "store", entityId: store.id, detail: { ...data, webhook: webhook ? "已填" : "没填" } });
    return store;
  } catch (error) {
    if (isUniqueViolation(error)) throw new OrgError("门店编码已经存在");
    throw error;
  }
}

export async function updateStore(actor: Actor, id: number, input: StoreInput) {
  assertCanManage(actor);
  const data = parseStoreInput(input);
  const webhook = parseWebhook(input.wecomWebhookUrl);
  try {
    const store = await prisma.store.update({ where: { id }, data: { ...data, ...(webhook !== undefined ? { wecomWebhookUrl: webhook } : {}) } });
    await writeAudit({ userId: actor.id, action: "store.update", entity: "store", entityId: id, detail: { ...data, ...(webhook !== undefined ? { webhook: webhook ? "改了" : "清掉了" } : {}) } });
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
  wecomUserid?: unknown; // 企业微信账号：不传表示不改，传空表示解绑（企业微信对接开着时才显示这个字段）
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
  const wecom = input.wecomUserid === undefined ? null : await checkWecomUserid(id, input.wecomUserid);
  const before = await prisma.user.findUnique({ where: { id }, select: { storeId: true } });
  let user;
  try {
    user = await prisma.user.update({ where: { id }, data: wecom ? { ...data, wecomUserid: wecom.value } : data });
  } catch (error) {
    if (isUniqueViolation(error)) throw new OrgError("这个企业微信账号已经绑给别的员工了");
    throw error;
  }
  await writeAudit({ userId: actor.id, action: "user.update", entity: "user", entityId: id, detail: data });
  await pruneNoticeNotifications(prisma, id); // 调了店、换了区域：看不到的公告消息从小铃铛里清掉
  if (wecom?.changed) await writeAudit({ userId: actor.id, action: "wecom.user.bind_userid", entity: "user", entityId: id, detail: { wecomUserid: wecom.value, checked: wecom.checked } });
  // 调了店：审批中的请假自动撤回，到新店重新提交（报销不撤，照原来的门店批，口径第 19 节）
  const moved = before !== null && before.storeId !== user.storeId;
  const cancelled = moved ? await cancelPendingOaFor(prisma, id, "调店了，审批中的单自动撤回，到新门店重新提交") : 0;
  // 调了店：明天起在老店的班删掉（今天的留着），到新店重新排
  const cleared = moved && before.storeId !== null ? await removeFutureShiftsFor(prisma, id, before.storeId, "调店了，老店明天起的班删掉，到新门店重新排", actor.id) : 0;
  const notices = [wecom?.notice, cancelled > 0 ? `他审批中的 ${cancelled} 张请假已自动撤回，到新门店重新提交` : null, cleared > 0 ? `他在老店明天起的 ${cleared} 格排班已删掉，到新门店重新排` : null].filter(Boolean);
  return { ...user, notice: notices.length ? notices.join("；") : undefined };
}

/**
 * 员工的企业微信账号（口径第 12 节）：格式对、没被别人占用；真对接时调企业微信通讯录核对确实是本企业成员，
 * 模拟模式没法核对，存上并提示。加好友事件按这个账号找跟进员工，填错了跟进关系就对不上人。
 */
async function checkWecomUserid(id: number, raw: unknown): Promise<{ value: string | null; changed: boolean; checked: boolean; notice?: string }> {
  if (wecomMode() === "off") throw new OrgError("企业微信对接没有打开");
  const value = typeof raw === "string" ? raw.trim() || null : null;
  const current = await prisma.user.findUnique({ where: { id }, select: { wecomUserid: true } });
  if ((current?.wecomUserid ?? null) === value) return { value, changed: false, checked: false };
  if (value === null) return { value, changed: true, checked: false };
  if (!WECOM_USERID_PATTERN.test(value)) throw new OrgError("企业微信账号只能是 1～64 位字母、数字和 _ - . @（在企业微信管理后台“通讯录”里看成员的账号）");
  const taken = await prisma.user.findFirst({ where: { wecomUserid: value, id: { not: id } }, select: { name: true } });
  if (taken) throw new OrgError(`这个企业微信账号已经绑给了${taken.name}`);
  const client = getWecomClient();
  if (client.mode === "simulated") return { value, changed: true, checked: false, notice: "模拟模式没有连企业微信，账号先存上，没有核对是不是本企业成员" };
  try {
    await client.getMember(value);
  } catch (error) {
    if (error instanceof WecomError) throw new OrgError(error.message);
    throw error;
  }
  return { value, changed: true, checked: true };
}

export async function resetUserPassword(actor: Actor, id: number, password: unknown) {
  assertCanManage(actor);
  await assertNotDemoAccount(id);
  const passwordHash = await hashPassword(requirePassword(password));
  // 版本号 +1：这个人之前的登录（可能在别人手里）马上失效，要用新密码重新登录
  await prisma.user.update({ where: { id }, data: { passwordHash, sessionVersion: { increment: 1 } } });
  await writeAudit({ userId: actor.id, action: "user.reset_password", entity: "user", entityId: id });
}

/**
 * 停用、启用员工。停用马上生效，不等企业微信的客户继承（口径第 12 节第三步）；
 * 传了接手人就给他跟进中的企业微信客户生成离职继承任务，没传的以后在客户继承页再安排。继承出错不影响停用，写在提示里。
 */
export async function setUserActive(actor: CurrentUser, id: number, isActive: boolean, options: { takeoverUserId?: number; db?: Db } = {}) {
  assertCanManage(actor);
  await assertNotDemoAccount(id);
  if (id === actor.id && !isActive) throw new OrgError("不能停用自己");
  const today = todayBizDate();
  const key = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
  // 停用（启用）、日志、离职日期、跟着撤的单放一个事务：中间哪步出错都不会出现“账号停了、离职日期没记”
  const { user, notice: inTxNotice } = await withTx(options.db ?? prisma, async (tx) => {
    const user = await tx.user.update({ where: { id }, data: { isActive, sessionVersion: { increment: 1 } } });
    const profile = await tx.employeeProfile.findUnique({ where: { userId: id }, select: { leaveDate: true, hireDate: true } });
    const before = key(profile?.leaveDate);
    let after = before;
    let autoLeaveDate: string | null = null;
    if (!isActive) {
      // 离职日期（口径第 19 节）：没填过的记成今天；总部已经填了的不覆盖；入职日期还没到的（人还没来上班）不记
      if (!profile?.leaveDate && !(profile?.hireDate && profile.hireDate > today)) {
        await tx.employeeProfile.upsert({ where: { userId: id }, create: { userId: id, leaveDate: today }, update: { leaveDate: today } });
        after = autoLeaveDate = key(today);
      }
    } else if (before) {
      // 重新启用：只清停用那一刻系统自动记的（总部手填的“月底走”留着），原值写进日志
      const last = await tx.auditLog.findFirst({ where: { action: "user.deactivate", entity: "user", entityId: String(id) }, orderBy: { id: "desc" }, select: { detail: true } });
      if ((last?.detail as { autoLeaveDate?: string } | null)?.autoLeaveDate === before) {
        await tx.employeeProfile.update({ where: { userId: id }, data: { leaveDate: null } });
        after = null;
      }
    }
    await writeAudit({ userId: actor.id, action: isActive ? "user.activate" : "user.deactivate", entity: "user", entityId: id, detail: { leaveDateBefore: before, leaveDateAfter: after, ...(autoLeaveDate ? { autoLeaveDate } : {}) } }, tx);
    let notice: string | undefined;
    if (isActive) {
      const cancelled = await cancelResignedTransfersFor(tx, id, "员工重新启用了，离职继承取消");
      if (cancelled.count > 0) notice = `他还在等删除成员的 ${cancelled.count} 个离职继承取消了`;
    } else {
      const cancelled = await cancelPendingOaFor(tx, id, "员工停用了，审批中的请假自动撤回");
      const cleared = await removeFutureShiftsFor(tx, id, null, "员工停用了，明天起的班删掉", actor.id);
      notice = [cancelled > 0 ? `他审批中的 ${cancelled} 张请假已自动撤回（报销照常审批、付款）` : null, cleared > 0 ? `明天起的 ${cleared} 格排班已删掉` : null].filter(Boolean).join("；") || undefined;
    }
    return { user, notice };
  });
  let notice = inTxNotice;
  if (!isActive && options.takeoverUserId) {
    try {
      const result = await createResignedTransfers(actor, { fromUserId: id, toUserId: options.takeoverUserId });
      notice = [notice, `${result.count} 个企业微信客户交给${result.to}：企业微信后台删掉这个人之后自动提交继承，进度在客户继承页看`].filter(Boolean).join("；");
    } catch (error) {
      if (!(error instanceof WecomTransferError)) throw error;
      notice = [notice, `账号已停用，企业微信客户没交接成：${error.message}，到客户继承页再安排`].filter(Boolean).join("；");
    }
  }
  return { ...user, notice };
}
