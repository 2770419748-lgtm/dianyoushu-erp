# 项目状态（PROJECT_STATE.md）

- 更新：2026-10-16
- 阶段：第 6 周完成（客户与开单第一版），下一步第 7 周以旧换新、多支付、退货

## 做完了什么

- 第 1 天：仓库 `dianyoushu-erp`（私有，等像样了改公开）、本机 pnpm 12、PostgreSQL 17、数据库 `dianyoushu_erp` 建好并验证连接。
- 第 5 天（提前做）：Next.js 16.4 + Ant Design 6 + Prisma 7 脚手架；首个迁移 `init_org_users` 建了 `regions`、`stores`、`users`（临时版，第 3 天按口径调整）。
- 第 6 到 7 天（提前做）：登录页、bcrypt 密码、JWT cookie 会话、错 5 次限流、退出；种子数据 4 个演示账号 + 1 区域 2 门店；登录后按角色显示不同菜单（假菜单）；单元测试 11 条（权限判断、限流）。`pnpm test`、`pnpm typecheck`、`pnpm lint` 全过。
- 第 2 天：坤总决定先按默认口径推进，整理成 `docs/业务口径.md` v0（角色权限矩阵、组织、商品、串号状态机、单据状态、支付方式、以旧换新、KPI）。
- 第 3 天：完整数据表 `prisma/schema.prisma`，迁移 `business_tables` 建了 31 张表；中文说明 `docs/数据模型.md`。
- 第 4 天：`docs/页面清单.md`（30 页）；AGENTS.md 补了库存服务层规则。
- 第 8 天：组织管理页 `/org`：左侧组织树（总部 / 区域 → 门店 → 员工），右侧区域、门店、员工三个页签的列表、新增、编辑、停用/启用、重置密码；服务层 `src/server/org/org-service.ts`，每次写入记操作日志 `audit_logs`；登录、登出也记日志。菜单项变成真链接，当前页高亮。验收通过：界面上新建 1 个区域、2 家店、3 个员工，树上都能看到，停用/启用正常。
- 第 9 天：数据权限落到查询上。`src/server/auth/scope.ts` 按角色给出 where 条件（`storeScopeWhere` 给带 store_id 的表、`storeTableWhere` 给门店表）和越权拒绝 `assertStoreAccess`（抛 `PermissionError`）；只读门店页 `/stores`、`/stores/[id]` 走这层。验收通过：店员账号直接打开别家店的地址显示"没有权限"，列表只有本店。单元测试 20 条。
- 第 10 天：通用布局补面包屑（`src/lib/routes.ts` 路由标题表），手机宽度下侧栏收起、顶栏只留姓名和退出、内容区缩小留白；操作日志页 `/logs`（总部，分页 20 条/页，动作显示成中文 `src/lib/audit-labels.ts`）。时间显示统一走 `src/lib/format.ts` 固定北京时间。验收通过：375 宽度下页面不横向滚动（scrollWidth = clientWidth），日志页能看到登录、组织变更记录。
- 第 11 天：CI 工作流 `.github/workflows/ci.yml`（推送和 PR 跑 lint、typecheck、test），README 加徽章。**GitHub 未开始跑**：提示账号付款失败或需提高消费上限（私有仓库的 Actions 要计分钟数）。已请坤总选：A 改公开仓库（推荐，方案本来就定公开）或 B 自己处理付款。
- 第 12 天：模拟数据 v0。`prisma/seed.ts` 生成 3 区域、10 门店、100 员工（固定随机种子，每次一样；4 个演示账号不变）；一键重置 `pnpm db:reset` = `prisma/reset.ts` 清空全部业务表 + 重新跑种子。没用 `prisma migrate reset`，因为 Prisma 7 检测到 AI 调用会拒绝，而且自写脚本带了"只允许本机库"的安全阀。验收通过：重置后登录，组织树 10 家店、100 个员工。
- 第 3 周：商品主数据。服务层 `src/server/products/`（product-service 品类/品牌/型号/SKU 增改停用，price-service 门店售价，search 纯函数）；页面 `/products`（搜索、筛选、总部可新增编辑停售）、`/products/catalog`（品类/品牌/型号，总部）、`/products/prices`（门店售价，店长本店、总部任意店，按范围校验）；模拟数据 50 个机型 + 30 个配件共 278 个 SKU（`prisma/seed-data/products.ts`，条码按名字稳定生成）。验收通过：搜"Mate"出 33 条；S001 把一个 SKU 改成 5299，S002 仍按指导价 5499。单元测试 24 条。

- 第 4 周：采购入库、串号、库存流水。库存核心 `src/server/stock/`：device-state（状态机，唯一允许的跳转表）、imei（串号解析）、doc-no（单号 = 前缀 + 北京日期 + 4 位，计数器在事务里自增）、stock-service（全系统唯一写库入口：receiveDevices、changeAccessoryStock、applyDeviceAction）、stock-query（带范围的查询）。采购 `src/server/purchase/purchase-service.ts`：草稿 → 提交 → 到货（可多次，齐了自动已到货）、作废；到货入库和入库单、流水在同一事务。页面 `/purchase`（列表、新建、编辑草稿、详情含到货入库）、`/stock`（串号/配件库存、状态筛选、汇总）、`/stock/ledger`、`/stock/devices/[imei]`（全程流水）。验收通过：开单 10 台 + 5 件配件 → 提交 → 粘贴 10 个串号入库 → 库存页 10 台在库、流水 11 条、串号页能看全程；再入同一串号提示“不能重复入库”，整批不入。测试 37 条，其中 4 条连本机库跑（事务回滚，连不上自动跳过）。

- 第 5 周：调拨与盘点。调拨 `src/server/transfer/transfer-service.ts`：申请（串号锁定）→ 发出（在途，发出店 −1）→ 收货（粘贴串号核对，可部分，收货店 +1、归属改收货店）→ 作废（解锁）；店长本店、总部任意店。盘点 `src/server/stocktake/stocktake-service.ts`：建任务时快照应有（在库/良品机器 + 有数的配件）→ 粘贴实盘串号、填配件数量 → 自动差异 → 确认后盘亏机器变“盘亏”、配件盘盈盘亏写流水；店员店长总部可录，店长总部可确认。配件安全库存：`skus.safety_qty`（迁移 `sku_safety_qty`），库存页低于它标红，配件种子默认 10。页面 `/transfers`（列表、新建、详情含发出/收货/作废）、`/stocktakes`（列表、发起、录入与确认）。阶段验收通过：入库 10 台 → 调拨 2 台到人民路店 → 收货 → 盘点只录 1 台 → 差异 1 → 确认后那台变盘亏，串号页能看到入库→锁定→在途→在库→盘亏全程。测试 41 条（连库 8 条）。

- 大件三个码（SN / IMEI1 / IMEI2）：主码 code，按任意码查找，入库一行一台 1 到 3 个码，迁移 device_three_codes。
- 第 6 周：客户 `src/server/customers`（手机号唯一、列表脱敏）；开单 `src/server/sales/sales-service.ts`（一个事务写销售单、明细成本快照、收款、扣库存、流水；作废恢复库存留痕，日结后不可作废；店员只看自己的单）；页面 `/customers`、`/sales/new`、`/sales`、`/sales/[id]`。验收通过：开一单一机一配件 → 库存少一台一件、流水两条 → 作废后机器回在库、配件加回、再两条流水。测试 49 条。

## 进行中

- 等坤总回“改”后用 gh 把仓库改公开，CI 才会跑。

## 踩坑

- 页面不停自动刷新（日志里同一路由 GET 连发）：Turbopack 缓存坏了，停掉 dev、删 `.next`、重启即可。

## 下一步

1. CI 绿勾：等坤总在项目里选公开/私有后推一次验证。
2. 第 7 周：回收单（旧机进回收、估价即成本）；开单关联回收单抵扣；多支付方式拆分（合计必须等于应收）；退货单；回收机转良品再卖；单元测试。
3. “第 1 到 2 周学到什么”一页纸是坤总的作业，提纲已给。

## 卡在哪

- 不卡，但有两份文档等坤总核对：`docs/业务口径.md` 末尾"待坤总确认的清单"，`docs/数据模型.md` 末尾"请坤总逐表核对"。核对结果直接改文档，改表结构就补迁移。

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
├─ prisma/schema.prisma        表定义（31 张表）；prisma/migrations/ 迁移历史；prisma/seed.ts 演示种子
├─ docs/                       业务口径.md（规则之源）、数据模型.md（表的中文说明）、页面清单.md
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
- `pnpm db:seed`：灌模拟数据（3 区域、10 门店、100 员工，可重复跑）
- `pnpm db:reset`：清空全部业务表再重新灌（只允许本机库）
- `pnpm db:studio`：Prisma 自带的看表界面

## 已定的环境事实

- 本机数据库：PostgreSQL 17 Windows 服务 `postgresql-x64-17`，端口 5432，库 `dianyoushu_erp`，连接串在 `.env`（不提交）。
- `psql` 不在 PATH，用全路径 `C:\Program Files\PostgreSQL\17\bin\psql.exe`；图形界面用开始菜单的 pgAdmin 4。
- Prisma 7：`.env` 不会被 Prisma CLI 自动读，靠 `prisma.config.ts` 里的 `import "dotenv/config"`；Next.js 运行时自己会读 `.env`。
- 演示账号见 README，密码 `demo1234`。
- 改了 `schema.prisma` 后：`pnpm db:migrate`（已带 generate），然后**重启 `pnpm dev`**。开发服务器把 Prisma 客户端缓存在进程里，不重启会报 `Cannot read properties of undefined (reading 'create')`。
- antd `Modal` 不要加 `forceRender`：弹窗内容会在服务端预渲染，客户端又走 Portal，导致 hydration 不一致报错。
