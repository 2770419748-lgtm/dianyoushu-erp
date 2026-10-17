// Next.js 服务器启动时调用一次（在开始接请求之前）。这里用来做上线前的配置检查：
// 生产环境发现会话密钥太短、还是占位值，或数据库连接没配，就打印原因并拒绝启动。
// 检查模块只在 Node.js 运行时动态加载（里面要用 process.exit，Edge 运行时没有）。
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { enforceProductionEnv } = await import("./server/config-check");
    enforceProductionEnv();
  }
}
