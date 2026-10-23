"use server";

import { requireUser } from "@/server/auth/current-user";
import { markNotificationsRead } from "@/server/alerts/alert-service";

// 顶栏消息：标已读（只能标自己的）。
export async function markReadAction(id: number) {
  const user = await requireUser({ allowFirstPassword: true });
  if (Number.isInteger(id)) await markNotificationsRead(user.id, [id]);
}

export async function markAllReadAction() {
  const user = await requireUser({ allowFirstPassword: true });
  await markNotificationsRead(user.id, "all");
}
