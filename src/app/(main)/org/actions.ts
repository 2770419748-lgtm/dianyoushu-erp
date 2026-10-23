"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current-user";
import * as org from "@/server/org/org-service";

// 组织管理页的 Server Function：只做"取当前用户 → 调服务层 → 刷新页面"，规则都在服务层。

export type ActionResult = { ok: true; notice?: string } | { ok: false; error: string };

async function run(fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn();
    revalidatePath("/org");
    return { ok: true };
  } catch (error) {
    if (error instanceof org.OrgError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function createRegionAction(input: { name: string }) {
  const user = await requireUser();
  return run(() => org.createRegion(user, input));
}

export async function updateRegionAction(id: number, input: { name: string }) {
  const user = await requireUser();
  return run(() => org.updateRegion(user, id, input));
}

export async function setRegionActiveAction(id: number, isActive: boolean) {
  const user = await requireUser();
  return run(() => org.setRegionActive(user, id, isActive));
}

export async function createStoreAction(input: org.StoreInput) {
  const user = await requireUser();
  return run(() => org.createStore(user, input));
}

export async function updateStoreAction(id: number, input: org.StoreInput) {
  const user = await requireUser();
  return run(() => org.updateStore(user, id, input));
}

export async function setStoreActiveAction(id: number, isActive: boolean) {
  const user = await requireUser();
  return run(() => org.setStoreActive(user, id, isActive));
}

export async function createUserAction(input: org.UserInput & { username: string; password: string }) {
  const user = await requireUser();
  return run(() => org.createUser(user, input));
}

export async function updateUserAction(id: number, input: org.UserInput) {
  const user = await requireUser();
  let notice: string | undefined;
  const result = await run(async () => {
    notice = (await org.updateUser(user, id, input)).notice;
  });
  return result.ok && notice ? { ok: true as const, notice } : result;
}

export async function resetUserPasswordAction(id: number, password: string) {
  const user = await requireUser();
  return run(() => org.resetUserPassword(user, id, password));
}

export async function resetUserMfaAction(id: number, reason: string) {
  const user = await requireUser();
  return run(() => org.resetUserMfa(user, id, reason));
}

export async function setUserActiveAction(id: number, isActive: boolean, takeoverUserId?: number) {
  const user = await requireUser();
  let notice: string | undefined;
  const result = await run(async () => {
    notice = (await org.setUserActive(user, id, isActive, { takeoverUserId })).notice;
  });
  return result.ok && notice ? { ok: true as const, notice } : result;
}
