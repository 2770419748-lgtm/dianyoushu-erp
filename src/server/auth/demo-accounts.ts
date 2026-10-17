// 演示账号保护：仓库公开、演示地址谁都能登录，如果有人用 hq 把 manager 的密码改了或者把账号停用，
// 后面来看演示的人就登不进去了。所以这 4 个账号不能改密码、不能停用、不能改角色和门店。
// （上线后还会每天自动重置数据和密码，见任务清单“找工作前再做”。）

export const DEMO_USERNAMES: ReadonlySet<string> = new Set(["hq", "regional", "manager", "staff"]);

export const DEMO_PROTECTED_MESSAGE = "演示账号受保护：不能改密码、停用或改角色。想试这些功能，先新建一个员工账号。";

export function isProtectedDemoAccount(username: string): boolean {
  return DEMO_USERNAMES.has(username);
}
