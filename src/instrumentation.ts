// Next.js 服务器启动时调用一次（在开始接请求之前）。这里用来做上线前的配置检查：
// 生产环境发现会话密钥太短、还是占位值，或数据库连接没配，就打印原因并拒绝启动。
// 检查模块只在 Node.js 运行时动态加载（里面要用 process.exit，Edge 运行时没有）。
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { enforceProductionEnv } = await import("./server/config-check");
    enforceProductionEnv();
    // 个人信息钥匙要和写这个库时用的一样（口径第 20 节），对不上拒绝启动：不然照常启动、健康检查也正常，但手机号搜不到、页面报错
    const [{ prisma }, { checkDataKeys }] = await Promise.all([import("./lib/prisma"), import("./server/pii/key-check")]);
    const keys = await checkDataKeys(prisma);
    if (!keys.ok) {
      console.error(`[店有数 ERP] 个人信息钥匙对不上，拒绝启动：${keys.reason}`);
      process.exit(1);
    }
  }
}
