// 测试里把 "server-only" 换成空模块：服务层文件顶部的 import "server-only" 在 vitest 环境会抛错，这里让它什么都不做。
export {};
