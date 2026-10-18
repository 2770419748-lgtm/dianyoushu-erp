# 项目状态（PROJECT_STATE.md）

- 更新：2026-10-17
- 阶段：12 周开发任务做完（第 12 周的 README、取舍记录、口径终版已完成，生产构建验证通过）；剩下坤总本人的：排练 3 次、架构说明、录屏，之后打 v1.0 标签

## 做完了什么

- 第 1 天：仓库 `dianyoushu-erp`（2026-10-17 已改公开）、本机 pnpm 12、PostgreSQL 17、数据库 `dianyoushu_erp` 建好并验证连接。
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
- 第 7 周：回收单 `src/server/tradein/trade-in-service.ts`（收旧机进回收库、成本 = 估价，转良品）；收款拆分与退款分摊纯函数 `src/server/sales/payments.ts`；开单接入以旧换新抵扣 + 多种收款（合计必须等于应收）；退货 `src/server/sales/return-service.ts`（退回库存、负数退款记在原单收款方式、抵扣不退、有退货不能作废）；页面 `/trade-ins`、`/trade-ins/new`、`/trade-ins/stock`、`/sales/[id]/return`，开单页加“以旧换新”和“再加一种收款”。迁移 `trade_in_device_code`；种子加“回收机（其他机型）”SKU。验收通过：开单现场收 iPhone 12 抵 1200 + 微信 3000 + 现金 1328 → 退掉钢化膜退 29 元 → 回收机转良品 → 1599 元卖出，毛利 399。测试 58 条。
- 第 8 周：日结 `src/server/dailyclose/`（summary 纯函数：按支付方式汇总、差异、能否确认；daily-close-service：逐笔比对、录实收、确认后当日销售单和退货单挂日结锁定、当天不能再开单退货、总部可撤销；收银日报 cashierReport）；页面 `/daily-close`、`/reports/cashier`，导出接口 `/api/reports/cashier`（CSV 带 BOM，Excel 直接打开）。端到端 `tests/e2e/sale-daily-close.spec.ts`（`pnpm test:e2e`，用本机 Edge）：店长登录 → 开单 → 配件库存少 1 → 日结微信系统数多出这单 → 作废还原。验收通过：中山路店当天现金 1328、微信 4570（3000 + 1599 − 29）、抵扣 1200，录实收确认后锁单，再撤销留给坤总试用。单元测试 63 条。
- 第 9 周：模拟数据生成器 `prisma/generate-demo.ts`（`pnpm db:reset` = 清空 → 基础种子 → 生成）：10 店、截至昨天 92 天，约 1.2 万张有效销售单、1500 张回收单（七成检测后转良品再卖）、约 190 张退货、1% 当天作废、每天日结（6% 有现金长短款）、周末和月底高峰、KPI 目标；跑完自检库存余额 = 流水、收款 = 应收、日结 = 收款汇总，全为 0 才算过，耗时约 30 秒。今天不生成，留给现场演示。看板 `/dashboard`（`src/server/dashboard/`，ECharts 按需引入）：日销趋势、门店月销对比、员工排名、热销机型 TOP10、KPI 完成率与门店日均差额、库存周转与滞销清单。测试 67 条 + 端到端 1 条。
- 第 10 周：手机开单 `/m/sale`（扫码或输码加商品，查找逻辑 `src/server/sales/lookup.ts`：先认 SN / IMEI1 / IMEI2，再认配件条码，只认本店能卖的；改价、旧机抵扣、一种收款、底部一键提交，下单走和电脑版同一个 `createSalesOrderAction`）；手机查库存 `/m/stock`；扫码 `src/lib/device/scanner.ts`（html5-qrcode）+ 共用按钮 `src/components/scan-button.tsx`，接进手机开单、电脑开单、到货入库、盘点、回收；本机临时 HTTPS `scripts/dev-https.mjs`（openssl 自签证书，放用户目录）；KPI 目标录入 `/kpi`（`src/server/kpi/kpi-service.ts`，门店 × 月四个数、复制上月、写日志）；后续规划 `/roadmap`；PWA（`src/app/manifest.ts`、`public/icons/`）；首页改成按角色的大按钮；本机备份 `scripts/backup-db.mjs` 与恢复演练 `scripts/restore-check.mjs`（已实际恢复一次，32 张表约 13 万行全对上）。顺手修了 `robots.txt` 被登录拦截、手机首屏侧栏闪一下。仓库改公开，CI 第一次绿。测试 73 条 + 端到端 2 条。
- 第 11 周：手机开单补“拆成两种收”；个人信息页 `/me`（改自己密码，旧密码错 5 次锁 15 分钟）；4 个演示账号受保护（`src/server/auth/demo-accounts.ts`，不能被改密码、停用、改角色）；全站安全响应头（`next.config.ts`）；安全基线逐项核对 `docs/安全基线.md`；回收库存改服务端分页、新建调拨可选机器上限 300 → 2000；库存流水单号能点开原单（`src/server/stock/doc-links.ts`）；调拨收货加扫码；按方案第 12 节演示路径完整走通一遍，写了 `docs/演示脚本.md`（含要粘贴的数据和每步用时）。各页服务端耗时实测 0.5 秒内，没加索引。测试 76 条 + 端到端 2 条。
- 第 12 周：README 终版；`docs/取舍记录.md`；`docs/业务口径.md` v1（对着代码核了一遍，修了调拨候选混进良品、看板旧机回收按回收单台数）；本机 `pnpm build` 通过，生产版本跑端到端两条都过。
- 代码审查修复（2026-10-17）：机器状态条件写入、配件原子增减 + CHECK 约束、门店 × 营业日咨询锁（`lockStoreDay`）、迁移 `integrity_checks`（配件余额 ≥ 0、收款二选一、已退数量范围）、重复码友好提示、CSV 防公式注入（`src/lib/csv.ts`）、新建调拨服务端搜索分页；并发测试 `tests/concurrency.db.test.ts`。测试 84 条 + 端到端 2 条。
- 复查后补（2026-10-17）：盘点明细、调拨明细加“一台机器只能一行”唯一约束（迁移 `item_device_unique`）；生产启动配置检查 `src/instrumentation.ts`（弱密钥、占位值、没配数据库就拒绝启动，本机实测过）；README / 部署文档写清演示密码；测试文件改为依次跑（`vitest.config.mts` 的 `fileParallelism: false`）。测试 87 条 + 端到端 2 条。
- 全面自检修复（2026-10-17）：另一个会话从头查了一遍，报告的 11 + 5 + 4 条和十几处小毛病都修了；单据级防并发 `src/server/db-lock.ts`；盘点按录入时的系统数算差异；退款上限 `returnRefundCapFen`；销售明细原价 `list_price_fen`；采购单只给总部、成本按角色去掉；登录 `src/server/auth/login-service.ts`（按用户名限流）；cookie Secure 按协议；停用账号清 cookie `/api/session/clear`；CI 起 PostgreSQL 跑全部测试和构建；回归测试 `tests/regression.db.test.ts`（`RUN_DESTRUCTIVE_TESTS=1` 才跑）。测试 100 条（含回归 7 条）+ 端到端 2 条。
- 生产上线补齐（2026-10-18，复审 9 条）：会话版本号（改密码、重置、停用后旧登录立刻失效，迁移 `user_session_version`，`src/server/auth/session-user.ts`）；演示模式开关 `DEMO_MODE`（默认开，0 = 真用）；`/api/health` + compose 健康检查、日志限额、Caddy 访问日志、`backup` 定时备份服务（`docker/backup.sh`）；登录限流在 Caddy 后按 IP + 用户名（`TRUST_PROXY`）；对账自检 `pnpm db:check`（`prisma/integrity-checks.ts`，CI 也跑）；CSP nonce（`src/proxy.ts`）；压测 `pnpm load-test`（`scripts/load-test.ts`）；`docs/部署.md` 开头“上线前检查清单”。

## 进行中

- 演示排练 3 次计时：脚本在 `docs/演示脚本.md`，要坤总本人来。

- 服务器和域名坤总决定先不买，等找工作前约 3 周再买（任务清单“找工作前再做”）。
- 手机真机扫码要坤总用自己的手机试一次（`pnpm dev:https`，见 README“手机上测试”）；电脑上已用手机尺寸跑通开单。
- 每日自动备份要坤总在 Windows 任务计划里登记一次（命令在 `docs/备份与恢复.md`）。

## 踩坑

- 页面不停自动刷新（日志里同一路由 GET 连发）：Turbopack 缓存坏了，停掉 dev、删 `.next`、重启即可。
- 连库测试并行跑会互相死锁（各自先改库存再开单，一个拿着门店当天的锁等库存行，另一个反过来）：测试文件已改成依次跑。
- 测并发不能在一个回滚事务里测：要两个事务真的同时跑并提交，测完把测试流水删掉、状态改回（见 `tests/concurrency.db.test.ts`）。
- 改了布局类组件后页面报 hydration 不一致、而且服务端 HTML 还是旧样子：开发服务器没收到文件变化，重启 `pnpm dev` 即可。
- `gh` 报找不到仓库：环境变量 `GITHUB_TOKEN` 盖住了本机登录，用 `env -u GITHUB_TOKEN gh …`。

## 下一步

1. 坤总：按 `docs/演示脚本.md` 排练 3 次计时；写一页架构说明（一张图：浏览器 / 手机 → Next.js 页面和 Server Function → `src/server` 服务层 → Prisma → PostgreSQL，旁边标权限校验、库存流水、事务三个关键点）；录 10 分钟演示。
2. 排练和录屏没问题后打 `v1.0` 标签；排练中发现的问题先修。
3. 找工作前约 3 周：买服务器和域名、备案、按 `docs/部署.md` 上线（任务清单“找工作前再做”）。
2. “第 1 到 2 周学到什么”一页纸是坤总的作业，提纲已给。

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
├─ docs/                       业务口径.md（规则之源）、数据模型.md（表的中文说明）、页面清单.md、备份与恢复.md、部署.md、安全基线.md、演示脚本.md、取舍记录.md
├─ scripts/                    dev-https（本机临时 HTTPS）、backup-db / restore-check（备份与恢复演练）
├─ tests/                      Vitest 单元测试
├─ prisma.config.ts            Prisma 7 配置，从 .env 读 DATABASE_URL，seed 命令
├─ next.config.ts              Next 配置（cacheComponents 不开）
├─ vitest.config.mts           测试配置（@ 别名指向 src）
├─ AGENTS.md / PROJECT_STATE.md / README.md
└─ .env（不提交：DATABASE_URL、SESSION_SECRET）/ .env.example
```

## 常用命令

- `pnpm dev`：启动开发服务器，浏览器开 http://localhost:3000 （或双击外层 `启动ERP.cmd`）
- `pnpm dev:https`：本机临时 HTTPS，手机连同一个 Wi-Fi 能打开并扫码（和 `pnpm dev` 二选一）
- `pnpm db:backup`：备份到代码目录旁边的“备份”文件夹，留 14 份；`pnpm db:restore-check`：恢复进临时库逐表对行数再删掉
- `pnpm test`：Vitest 单元测试（含连本机库的核心链路测试，跑完回滚）
- 回归测试会写库：本机要跑先建副本库，`DATABASE_URL=副本 RUN_DESTRUCTIVE_TESTS=1 pnpm vitest run tests/regression.db.test.ts`，别在日常用的库上跑；CI 每次都是全新库，默认就跑。
- `pnpm test:e2e`：Playwright 端到端两条：电脑开单到日结、手机尺寸开单（用本机 Edge，开发服务器开着就复用）
- `pnpm typecheck`：先生成路由类型再做 TypeScript 检查
- `pnpm lint`：ESLint
- `pnpm db:migrate`：改了 schema.prisma 后生成并执行迁移
- `pnpm db:seed`：灌模拟数据（3 区域、10 门店、100 员工，可重复跑）
- `pnpm db:check`：对账自检（配件余额 = 流水、机器数 = 流水、收款 = 应收、已确认日结 = 收款），对不上退出码 1
- `pnpm load-test [并发] [每路次数]`：压测 11 个页面，先 `pnpm build && pnpm start`；`LOAD_BASE` 改地址
- `pnpm db:reset`：清空全部业务表 → 基础种子 → 生成 3 个月模拟经营数据（只允许本机库，约 30 秒）
- `pnpm db:studio`：Prisma 自带的看表界面

## 已定的环境事实

- 本机数据库：PostgreSQL 17 Windows 服务 `postgresql-x64-17`，端口 5432，库 `dianyoushu_erp`，连接串在 `.env`（不提交）。
- `psql` 不在 PATH，用全路径 `C:\Program Files\PostgreSQL\17\bin\psql.exe`；图形界面用开始菜单的 pgAdmin 4。
- Prisma 7：`.env` 不会被 Prisma CLI 自动读，靠 `prisma.config.ts` 里的 `import "dotenv/config"`；Next.js 运行时自己会读 `.env`。
- 演示账号见 README，密码 `demo1234`。
- 改了 `schema.prisma` 后：`pnpm db:migrate`（已带 generate），然后**重启 `pnpm dev`**。开发服务器把 Prisma 客户端缓存在进程里，不重启会报 `Cannot read properties of undefined (reading 'create')`。
- antd `Modal` 不要加 `forceRender`：弹窗内容会在服务端预渲染，客户端又走 Portal，导致 hydration 不一致报错。
