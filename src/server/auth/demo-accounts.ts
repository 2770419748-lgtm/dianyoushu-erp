// 演示模式（DEMO_MODE，默认开；真上线给门店用时设 DEMO_MODE=0）。
//
// 开着的时候：hq、regional、manager、staff 这 4 个公开密码的账号受保护——不能改密码、不能停用、
// 不能改角色和门店，登录也不限流；登录页显示演示账号；允许 pnpm db:reset 清库重来。
// 因为演示地址谁都能登录，有人用 hq 把 manager 的密码改了，后面来看演示的人就登不进去了。
//
// 关掉（DEMO_MODE=0）：这 4 个账号就是普通账号，可以改密码、停用（上线前必须这么做，它们的密码是公开的）；
// 登录页不再显示演示账号；重置脚本拒绝执行，免得误清真实数据。见 docs/部署.md 的“上线前检查清单”。

export const DEMO_MODE = process.env.DEMO_MODE !== "0";

export const DEMO_USERNAMES: ReadonlySet<string> = new Set(["hq", "regional", "manager", "staff"]);

export const DEMO_PROTECTED_MESSAGE = "演示账号受保护：不能改密码、停用或改角色。想试这些功能，先新建一个员工账号。";

export function isProtectedDemoAccount(username: string): boolean {
  return DEMO_MODE && DEMO_USERNAMES.has(username);
}
