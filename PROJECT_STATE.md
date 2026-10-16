# 项目状态（PROJECT_STATE.md）

- 更新：2026-10-16
- 阶段：第 1 周（口径、数据表、脚手架、登录）

## 做完了什么

- 第 1 天：仓库 `dianyoushu-erp`（私有，等像样了改公开）、本机 pnpm 12、PostgreSQL 17、数据库 `dianyoushu_erp` 建好并验证连接。
- 第 5 天（提前做）：Next.js 16.4 + Ant Design 6 + Prisma 7 脚手架；首个迁移 `init_org_users` 建了 `regions`、`stores`、`users`（临时版，第 3 天按口径调整）。
- 第 6 到 7 天（提前做）：登录页、bcrypt 密码、JWT cookie 会话、错 5 次限流、退出；种子数据 4 个演示账号 + 1 区域 2 门店；登录后按角色显示不同菜单（假菜单）；单元测试 11 条（权限判断、限流）。`pnpm test`、`pnpm typecheck`、`pnpm lint` 全过。

## 进行中

- 第 2 天《业务口径 v0》：8 个问题已发给坤总，等回答后整理成 `docs/业务口径.md`。

## 下一步

1. 收到口径回答 → 第 3 天数据表设计（完整 `prisma/schema.prisma`、`docs/数据模型.md`），补迁移调整组织与用户表。
2. 第 4 天页面清单（`docs/页面清单.md`）。
3. 第 8 天组织管理（区域、门店、员工增改停用、组织树）；第 9 天数据权限接到每个查询；第 10 天通用布局与操作日志；第 11 天 CI。

## 卡在哪

- 无。

## 目录结构（当前）

```
code/
├─ src/app/layout.tsx          根布局；providers.tsx 注册 antd 样式 + 中文
├─ src/app/(auth)/login/       登录页：page.tsx（服务端）、login-form.tsx（客户端表单）、actions.ts（登录/登出 Server Function）
├─ src/app/(main)/             登录后的页面：layout.tsx 查当前用户并套 app-shell.tsx（侧栏菜单 + 顶栏）；page.tsx 首页
├─ src/proxy.ts                请求入口的 cookie 检查（没登录跳 /login）
├─ src/server/auth/            token（JWT）、session（cookie）、password（bcrypt）、rate-limit（限流）、permissions（角色与数据范围）、current-user
├─ src/lib/prisma.ts           Prisma 客户端单例（pg 驱动适配器）
├─ src/generated/prisma        prisma generate 生成，不进仓库
├─ prisma/schema.prisma        表定义；prisma/migrations/ 迁移历史；prisma/seed.ts 演示种子
├─ tests/                      Vitest 单元测试
├─ prisma.config.ts            Prisma 7 配置，从 .env 读 DATABASE_URL，seed 命令
├─ next.config.ts              Next 配置（cacheComponents 不开）
├─ vitest.config.mts           测试配置（@ 别名指向 src）
├─ AGENTS.md / PROJECT_STATE.md / README.md
└─ .env（不提交：DATABASE_URL、SESSION_SECRET）/ .env.example
```

## 常用命令

- `pnpm dev`：启动开发服务器，浏览器开 http://localhost:3000 （或双击外层 `启动ERP.cmd`）
- `pnpm test`：Vitest 单元测试
- `pnpm typecheck`：先生成路由类型再做 TypeScript 检查
- `pnpm lint`：ESLint
- `pnpm db:migrate`：改了 schema.prisma 后生成并执行迁移
- `pnpm db:seed`：灌演示账号与示范门店（可重复跑）
- `pnpm db:studio`：Prisma 自带的看表界面

## 已定的环境事实

- 本机数据库：PostgreSQL 17 Windows 服务 `postgresql-x64-17`，端口 5432，库 `dianyoushu_erp`，连接串在 `.env`（不提交）。
- `psql` 不在 PATH，用全路径 `C:\Program Files\PostgreSQL\17\bin\psql.exe`；图形界面用开始菜单的 pgAdmin 4。
- Prisma 7：`.env` 不会被 Prisma CLI 自动读，靠 `prisma.config.ts` 里的 `import "dotenv/config"`；Next.js 运行时自己会读 `.env`。
- 演示账号见 README，密码 `demo1234`。
