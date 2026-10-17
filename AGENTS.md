# 店有数 ERP：开发规则（AGENTS.md）

Claude Code 与 Codex 共用这一份。做任何任务前先读本文件、`PROJECT_STATE.md`，再读 `docs/业务口径.md` 里对应的小节。

## 项目是什么

手机零售门店经营系统的演示版，应聘时当场演示：采购入库 → 调拨 → 门店开单（含以旧换新）→ 库存自动减 → 日结对账 → 看板。范围、选型、业务规则以 `D:\店有数ERP系统\手机零售ERP演示版方案.md` 为准（方案文档不在仓库里，由规划线程维护，开发线程不改它）。逐周任务见同目录 `任务清单.md`。

## 技术栈（已定，不换）

| 层 | 选择 |
|---|---|
| 运行环境 | Node 24、pnpm 12 |
| 框架 | Next.js 16（App Router，`src/` 目录，TypeScript strict） |
| 界面 | Ant Design 6（React 19），中文语言包，不用 Tailwind，不自己画组件 |
| 数据库 | PostgreSQL 17（本机 Windows 服务），Prisma 管表结构与迁移 |
| 登录 | 账号密码 + bcrypt 哈希 + cookie 会话，登录接口限流 |
| 测试 | Vitest 测业务规则（只盖核心链路：开单扣库存、日结对账、权限判断；`*.db.test.ts` 连本机库在事务里跑完回滚）；Playwright 1 到 2 条端到端（`tests/e2e`，本机 Edge） |
| 部署 | 第 9 周：Docker + 一台云服务器 + Caddy HTTPS，GitHub Actions 自动部署 |

Next.js 16 比训练数据新（Middleware 改名 Proxy，`src/proxy.ts`；本项目不开 `cacheComponents`，页面按常规动态渲染）：写涉及路由、缓存、`params`、表单动作的代码前，先读 `node_modules/next/dist/docs/` 里对应章节，遵守废弃提示。

## 目录结构

```
code/
├─ src/app/            页面与路由（App Router）；(auth)、(main) 等路由组按模块分
├─ src/app/api/        HTTP 接口（只在页面动作不够用时才加）
├─ src/server/         业务服务层：权限检查、库存流水、开单事务、日结；所有写库都从这里走
├─ src/lib/            prisma 客户端、工具函数、常量
├─ src/components/     通用界面组件（布局、表格封装）
├─ prisma/             schema.prisma、migrations/、seed.ts
├─ docs/               业务口径.md、数据模型.md、页面清单.md
├─ tests/              Vitest 单元测试；e2e/ 放 Playwright
├─ AGENTS.md           本文件
└─ PROJECT_STATE.md    当前进度、下一步、卡在哪
```

## 命名规则

- 文件与目录：kebab-case（`stock-ledger.ts`）；React 组件文件 PascalCase（`StoreTree.tsx`）。
- Prisma 模型 PascalCase、字段 camelCase，用 `@@map` / `@map` 映射到 snake_case 的表名和列名。
- 金额一律整数"分"，字段名以 `Fen` 结尾（`priceFen`、`paidFen`）；不用浮点数。
- 数量字段 `qty`；时间字段 `DateTime`，统一 UTC 存、界面按本地显示。
- 单据号格式 `前缀 + yyyyMMdd + 4 位流水`，前缀：采购 PO、入库 RI、调拨 TR、盘点 ST、销售 SO、退货 RT、回收 RC、日结 DC。
- 界面文案、注释、提交说明用中文；代码标识符用英文。
- Ant Design 组件只在客户端组件（文件顶部 `"use client"`）里用：服务端组件拿不到 `Typography.Title`、`Card.Meta` 这类子组件（会报 Element type is invalid）。做法是页面 `page.tsx` 在服务端查数据，再传给同目录的 `xxx-view.tsx` 客户端组件渲染。antd 6 里 `Space` 的 `direction` 已改名 `orientation`。

## 必须守住的业务规则（来自方案 6.5）

1. 串号全局唯一，状态只能按状态机走：在途 → 在库 → 已售；回收 → 良品 → 已售。
2. 所有库存变化走库存流水，不直接改余额；余额永远能从流水算出来。
3. 开单扣库存、记收款、写流水在一个数据库事务里，失败全部回滚。
4. 单据不物理删除，只能作废，作废留痕。
5. 金额用整数"分"存。
6. 权限在服务端校验（`src/server` 层），不只靠前端藏菜单。

## 禁止事项

- 不碰 `.env`，不把密码、密钥、Token 写进任何会提交的文件；`.env.example` 只放占位符。
- 不物理删除单据，不直接 UPDATE 库存余额。
- 不绕过 `src/server` 的权限检查直接在页面里查库。
- 不引入方案之外的重依赖（消息队列、缓存层、微服务、Tailwind、状态管理库）。
- 不改方案文档；需求变了改代码，并在 `任务清单.md` 末尾"变更记录"写日期、改了什么、为什么。
- 不过度工程：测试只盖核心链路，不照搬店有数桌面版的发布门禁。

## 工作方式

1. 先读本文件、`PROJECT_STATE.md`、`docs/业务口径.md` 对应小节，再动手。
2. 做完跑 `pnpm typecheck` 和相关测试（`pnpm test`）。
3. 更新 `PROJECT_STATE.md`，用一段话说明改了哪些文件、为什么。
4. 每天结束 `git commit` 并推到 GitHub，程序要能跑。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 登录与权限的实现约定（第 6 到 7 天）

- 会话：`src/server/auth/token.ts` 用 jose 签 JWT（HS256，密钥 `SESSION_SECRET`），`session.ts` 写进 httpOnly cookie `erp_session`，7 天过期；登出删 cookie。
- `src/proxy.ts`（Next 16 的 Proxy，原 Middleware）只做乐观检查：没 cookie 去 `/login`，有 cookie 不进 `/login`。真正的用户状态由 `src/server/auth/current-user.ts` 的 `requireUser()` 查库确认，页面和服务层都要调它，不要信前端。
- 密码：`password.ts` bcryptjs 10 轮；登录限流 `rate-limit.ts` 内存计数，同账号同 IP 15 分钟错 5 次锁 15 分钟。
- 数据范围：`permissions.ts` 的 `getDataScope` / `canAccessStore` 是纯函数，所有按门店过滤的查询都从这里取范围；单元测试在 `tests/`。
- 页面表单提交用 Server Function（文件顶部 `"use server"`，客户端用 `useActionState`），不另写 API 路由。

## 规则之源与库存服务层（第 2 到 4 天补）

- 业务规则以 `docs/业务口径.md` 为准（角色权限矩阵、串号状态机、单据状态、支付方式、以旧换新、KPI）；表结构说明在 `docs/数据模型.md`；页面与路由在 `docs/页面清单.md`。改口径先改文档再改代码。
- 库存只能通过 `src/server/stock/` 的服务层改（第 4 周建）：串号状态跳转按口径第 4 节的表校验；每次变动写 `stock_ledgers`，小件同一事务更新 `accessory_stocks` 并记 `balance_after`；不允许在页面或别的服务里直接 update `devices.status` 或 `accessory_stocks.qty`。
- 机器编码：`devices.code` 是主码（IMEI1 ?? SN ?? IMEI2），链接、显示用它；按码找机器一律用 `deviceCodeWhere(code)`（四个列都匹配），粘贴解析用 `src/server/stock/imei.ts` 的 `parseDeviceCodeLines`（入库，一行一台）和 `parseCodeList`（盘点、收货，一批单个码）。
- 单号用 `doc_counters` 在事务里自增：`前缀 + yyyyMMdd + 4 位`。
- 所有列表和详情查询先用 `getDataScope(user)` 取范围，再按 `store_id` 过滤；跨店访问返回无权限，不要只在前端隐藏。
- 金额列一律 `xxxFen` 整数；汇总在数据库里 `SUM` 出 bigint 再转数字。

## 并发（2026-10-17 补）

- 改机器状态、配件数量一律走 `stock-service`：机器用“状态没变才更新”的条件写入，配件用原子增减，不要自己先读再写回。
- 新写的单据操作如果会影响某店某天的收银（开单、作废、退货、日结），事务一开始先调 `lockStoreDay(tx, storeId, bizDate)`，拿到锁之后再读数据做检查。
- 唯一约束、检查约束是兜底，业务代码仍要先检查给出好懂的提示；撞上约束时用 `src/server/db-errors.ts` 认出来换成人话。

## 保留升级成 App 的路径（2026-10-16 坤总要求）

目标：以后用 Capacitor 一类工具把现有网页打包成安卓 / iOS 应用，不重写。为此一直守住：

1. 业务逻辑只放 `src/server/` 的服务层；页面里的 Server Function 和以后的 `/api` 路由都只是薄薄一层调用，不写规则。App 要独立接口时，给同一套服务层加 `src/app/api/` 的 Route Handler 即可。
2. 登录令牌是 JWT（`src/server/auth/token.ts`），签发和校验不依赖 cookie；App 版改为请求头 `Authorization: Bearer` 时复用同一份校验代码。
3. 用到设备能力的功能（扫码、拍照、定位）封装成独立模块放 `src/lib/device/`，对外只暴露接口，网页版用浏览器 API 实现，App 版换原生插件实现，调用方不改。现有：扫码 `src/lib/device/scanner.ts`（`startScanner`），页面里一律用共用按钮 `src/components/scan-button.tsx`，不要在页面里直接引 html5-qrcode。
4. 手机端页面按 PWA 做：清单 `src/app/manifest.ts`、图标 `public/icons/`（`src/proxy.ts` 已放行，不登录也能取），界面不依赖鼠标悬停，触控优先。手机专用页面放 `src/app/(main)/m/`，不显示面包屑。
5. 不做的：React Native / Flutter 独立工程、离线同步、应用商店上架流程。这些等真要上架时再做，不进当前清单。
- 时间显示一律用 `src/lib/format.ts` 的 `formatDateTime` / `formatDate`（固定北京时间），金额显示用 `formatFen`；不要在组件里直接 `dayjs(x).format`，否则服务端和浏览器时区不同会报 hydration 不一致。
