// Next.js 服务器启动时调用一次（在开始接请求之前）。这里用来做上线前的配置检查：
// 生产环境发现会话密钥太短、还是占位值，或数据库连接没配，就打印原因并拒绝启动。
// 检查模块只在 Node.js 运行时动态加载（里面要用 process.exit，Edge 运行时没有）。
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { enforceProductionEnv } = await import("./server/config-check");
    enforceProductionEnv();
    // 个人信息钥匙要和写这个库时用的一样（口径第 20 节），对不上拒绝启动：不然照常启动、健康检查也正常，但手机号搜不到、页面报错。
    // 连不上库（服务器重启时应用常比数据库先起来）：每 2 秒重试、最多 2 分钟，还连不上就退出，让 Docker 按 restart 策略重拉；
    // 不能吞掉错误接着跑，那样以后每个请求都 500、库好了也不恢复（2026-10-23 快核第 63 条）。
    // 密码错、库名错、没跑迁移等多久都不会好：直接退出，日志写明原因（快核第 64 条）
    const [{ prisma }, { checkDataKeys }, { describeDbStartupError }] = await Promise.all([
      import("./lib/prisma"),
      import("./server/pii/key-check"),
      import("./server/startup-db"),
    ]);
    for (let attempt = 1; ; attempt++) {
      try {
        const keys = await checkDataKeys(prisma);
        if (!keys.ok) {
          console.error(`[店有数 ERP] 个人信息钥匙对不上，拒绝启动：${keys.reason}`);
          process.exit(1);
        }
        if (attempt > 1) console.warn("[店有数 ERP] 数据库连上了，钥匙核对通过");
        break;
      } catch (error) {
        const { fatal, reason } = describeDbStartupError(error);
        if (fatal) {
          console.error(`[店有数 ERP] 数据库连得上但用不了，拒绝启动：${reason}`);
          process.exit(1);
        }
        if (attempt >= 60) {
          console.error(`[店有数 ERP] 2 分钟还连不上数据库，退出等重启：${reason}`);
          process.exit(1);
        }
        if (attempt === 1) console.warn(`[店有数 ERP] 启动时连不上数据库，每 2 秒重试一次（最多 2 分钟）：${reason}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
}
