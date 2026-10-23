import { describe, expect, it } from "vitest";
import { describeDbStartupError } from "@/server/startup-db";

// 启动时连库失败（快核第 64 条）：Prisma 报错第一行是空的，原因取最后一行并带上错误代码；
// 密码错、库名错、没跑迁移直接退出，库还没起来才等。

function prismaError(code: string, last: string) {
  return Object.assign(new Error(`\nInvalid \`prisma.systemSetting.findUnique()\` invocation in\n/app/x.js:1:1\n\n→ 1 await prisma.systemSetting.findUnique(\n${last}`), { code });
}

describe("启动时连库失败", () => {
  it("密码错、没跑迁移、库名错：直接退出，写明原因和错误代码", () => {
    const auth = describeDbStartupError(prismaError("P1000", "Authentication failed against the database server"));
    expect(auth.fatal).toBe(true);
    expect(auth.reason).toContain("密码不对");
    expect(auth.reason).toContain("P1000 Authentication failed");
    const table = describeDbStartupError(prismaError("P2021", "The table `public.system_settings` does not exist in the current database."));
    expect(table).toMatchObject({ fatal: true });
    expect(table.reason).toContain("还没跑迁移");
    expect(describeDbStartupError(prismaError("P1003", "Database `x` does not exist")).fatal).toBe(true);
  });

  it("库还没起来：接着等，原因不是空的", () => {
    const refused = describeDbStartupError(Object.assign(new Error("\nInvalid invocation\n"), { code: "ECONNREFUSED" }));
    expect(refused.fatal).toBe(false);
    expect(refused.reason).toContain("ECONNREFUSED");
    expect(describeDbStartupError(new Error("connect ETIMEDOUT")).reason).toBe("connect ETIMEDOUT");
    expect(describeDbStartupError("怪东西").reason).toBe("怪东西");
  });
});
