import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { isValidFen } from "@/lib/limits";
import { maskPhone } from "@/lib/sales-labels";
import { canEditEmployees, canViewEmployees } from "@/server/auth/permissions";
import type { CurrentUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { writeAudit } from "@/server/audit";
import { asTx, type Db } from "@/server/db-tx";

// 员工档案（口径第 19 节）：员工就是 ERP 的账号，档案补入职日期、岗位、电话、基本工资、离职日期。
// 看：店长本店、区域经理辖区（都看不到工资），总部全部；改：总部。工资只有本人和总部能看。

export class EmployeeError extends Error {}

/** 能看哪些员工：店长本店的人；区域经理辖区各店的人和自己；总部全部 */
export function employeeScopeWhere(user: CurrentUser): Prisma.UserWhereInput {
  switch (user.role) {
    case "HQ":
      return {};
    case "REGIONAL_MANAGER":
      return { OR: [{ store: { regionId: user.regionId ?? -1 } }, { regionId: user.regionId ?? -1 }] };
    case "STORE_MANAGER":
      return { storeId: user.storeId ?? -1 };
    case "STAFF":
      return { id: user.id };
  }
}

function parseDate(value: unknown, label: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new EmployeeError(`${label}的格式是 2026-10-21`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new EmployeeError(`${label}不是真实的日期`);
  return d;
}

export async function listEmployees(user: CurrentUser, query: { storeId?: number; q?: string; includeInactive?: boolean }) {
  if (!canViewEmployees(user.role)) throw new PermissionError("员工档案店长、区域经理和总部能看");
  const q = query.q?.trim();
  const rows = await prisma.user.findMany({
    where: {
      AND: [
        employeeScopeWhere(user),
        query.storeId ? { storeId: query.storeId } : {},
        query.includeInactive ? {} : { isActive: true },
        q ? { OR: [{ name: { contains: q } }, { username: { contains: q, mode: "insensitive" } }] } : {},
      ],
    },
    orderBy: [{ storeId: "asc" }, { role: "desc" }, { id: "asc" }],
    take: 300,
    select: { id: true, username: true, name: true, role: true, isActive: true, store: { select: { id: true, code: true, name: true } }, region: { select: { name: true } }, profile: true },
  });
  const showSalary = user.role === "HQ";
  return {
    showSalary,
    canEdit: canEditEmployees(user.role),
    rows: rows.map((u) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      role: u.role,
      isActive: u.isActive,
      store: u.store ? `${u.store.code} ${u.store.name}` : null,
      region: u.region?.name ?? null,
      position: u.profile?.position ?? null,
      hireDate: u.profile?.hireDate ?? null,
      leaveDate: u.profile?.leaveDate ?? null,
      phoneMasked: u.profile?.phone ? maskPhone(u.profile.phone) : null,
      phone: showSalary ? (u.profile?.phone ?? null) : null, // 总部编辑时要原值
      baseSalaryFen: showSalary ? (u.profile?.baseSalaryFen ?? 0) : null,
      note: showSalary ? (u.profile?.note ?? null) : null,
    })),
  };
}

export type EmployeeList = Awaited<ReturnType<typeof listEmployees>>;

/** 总部改档案 */
export async function saveEmployeeProfile(user: CurrentUser, userId: number, input: { hireDate?: unknown; position?: unknown; phone?: unknown; baseSalaryFen?: unknown; leaveDate?: unknown; note?: unknown }, db: Db = prisma) {
  if (!canEditEmployees(user.role)) throw new EmployeeError("员工档案只有总部能改");
  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!target) throw new EmployeeError("员工不存在");
  const phone = typeof input.phone === "string" ? input.phone.replace(/\s/g, "") : "";
  if (phone && !/^1\d{10}$/.test(phone)) throw new EmployeeError("联系电话填 11 位手机号");
  const salary = input.baseSalaryFen === undefined || input.baseSalaryFen === "" || input.baseSalaryFen === null ? 0 : Number(input.baseSalaryFen);
  if (!Number.isInteger(salary) || salary < 0 || !isValidFen(salary)) throw new EmployeeError("基本工资不对");
  const hireDate = parseDate(input.hireDate, "入职日期");
  const leaveDate = parseDate(input.leaveDate, "离职日期");
  if (hireDate && leaveDate && leaveDate < hireDate) throw new EmployeeError("离职日期不能早于入职日期");
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) || null : null);
  const data = { hireDate, position: text(input.position, 20), phone: phone || null, baseSalaryFen: salary, leaveDate, note: text(input.note, 200) };
  await db.employeeProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  // 日志不写电话和工资的具体值
  await writeAudit({ userId: user.id, action: "employee.profile.save", entity: "user", entityId: userId, detail: { position: data.position, hireDate: data.hireDate, leaveDate: data.leaveDate } }, asTx(db));
}

/** “我的”页：自己的档案（工资给本人看） */
export async function getMyProfile(userId: number) {
  const p = await prisma.employeeProfile.findUnique({ where: { userId } });
  return p ? { hireDate: p.hireDate, position: p.position, phone: p.phone, baseSalaryFen: p.baseSalaryFen, leaveDate: p.leaveDate } : null;
}
