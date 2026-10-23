import "dotenv/config";
import { describe, expect, it } from "vitest";
import type { CurrentUser } from "@/server/auth/current-user";
import { AccountError, changeOwnPassword } from "@/server/auth/account-service";
import { isProtectedDemoAccount } from "@/server/auth/demo-accounts";

// 公开演示时的保护：4 个演示账号不能改密码；普通账号改密码先过格式检查（这几条都在查库之前就拦下）。

function fakeUser(username: string): CurrentUser {
  return { id: 999999, username, name: "测试", role: "STAFF", storeId: 1, regionId: null, mustChangePassword: false, isActive: true, store: null, region: null };
}

describe("演示账号保护", () => {
  it("hq / regional / manager / staff 受保护，其他账号不受", () => {
    for (const name of ["hq", "regional", "manager", "staff"]) expect(isProtectedDemoAccount(name)).toBe(true);
    expect(isProtectedDemoAccount("staff_s001_01")).toBe(false);
  });

  it("演示账号改自己密码直接拒绝", async () => {
    await expect(changeOwnPassword(fakeUser("manager"), "demo1234", "newpass123")).rejects.toBeInstanceOf(AccountError);
  });

  it("新密码太短、和旧密码一样都拒绝", async () => {
    await expect(changeOwnPassword(fakeUser("someone"), "oldpass1", "123")).rejects.toThrow("至少 6 位");
    await expect(changeOwnPassword(fakeUser("someone"), "samepass", "samepass")).rejects.toThrow("不能和旧密码一样");
  });
});
