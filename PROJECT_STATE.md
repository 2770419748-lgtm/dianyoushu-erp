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
- 第三轮深审修复（2026-10-18）：本系统卖出的机器可以被回收单收回（沿用原机器记录，状态机加“已售 → 回收”，`retakeSoldDevice`）；机器开单默认价 门店售价 → 指导价 → 成本（`deviceDefaultPriceFen`）；数量 ≤ 9999、金额 ≤ 1000 万元（`src/lib/limits.ts`）；成本（含参考成本）店长及以上可见、店员不可见（坤总选的，`canSeeCost`）；对账自检加“机器状态 / 门店 = 最后一条流水、已售 = 有没退的有效销售单”；前端扫码断网提示、优惠超合计提示、盘点文案、品类排序整数、回收库存只转一行；页面清单、数据模型、口径 v1.2 按代码核对。测试 111 条（含回归 12 条）+ 端到端 2 条。
- 服务权益（2026-10-20，企业微信 PRD 第一步，坤总选“服务权益 + 企微模拟演示”）：SKU 加 `is_service`、`service_months`；开单服务行不动库存、必须选客户、一行一份、选保哪台机器，事务内生成 `service_entitlements`；作废、退掉服务置失效；到期日 = 营业日 + N 个月 − 1 天（`src/lib/entitlement.ts`）；到期名单 `/entitlements` 两档区间、每档只生成一次提醒（`entitlement_reminders`）、记“已联系”；客户详情 `/customers/[id]`（别人开的单只给摘要）；采购拒收服务；对账自检加第 6 类“服务权益和单据”；演示数据带约 1800 份碎屏险和延保、到期提醒。开工前在 e60c576 打了基线标签 `baseline-before-wecom`。
- 企业微信底座 + 模拟演示（2026-10-20，第二步）：`src/server/wecom/`（加解密用官方示例向量单测、回调验签去重、令牌落库缓存、真/模拟两种接口）；`/api/wecom/callback`（只有 `WECOM_ENABLED=1` 打开，proxy 不拦）；员工企业微信账号（组织管理）；销售单详情“加企业微信”（开单绑定码 + 只给开单人的活码，模拟模式下“模拟客户扫码加好友”）；加好友按绑定码绑客户、立刻发欢迎语、删活码；删好友分员工删客户 / 客户删员工；客户详情企业微信区（跟进关系按员工本人、本店店长、辖区、总部过滤）；`/wecom` 企微对接页（总部）；每日任务 `pnpm daily`；启动检查要求生产环境写明 `DEMO_MODE`、真对接配置齐全；迁移 `wecom_base`（6 张表，另给员工、客户加了企业微信字段）；演示数据带 2330 条好友关系和标签。没做：侧边栏、微信客服、离职继承、自动打标、群发、认领。
- 售后维修（2026-10-20，剩余模块第 1 项）：口径第 13 节；`repair_orders`（迁移 `repair_orders`）+ `payments.repair_order_id`（收款三选一 CHECK）+ `skus.service_kind` + 权益状态 CLAIMED；`src/lib/repair.ts`（谁能付的规则，纯函数）、`src/server/repair/repair-service.ts`；页面 `/repairs`、`/repairs/new`、`/repairs/[id]`，机器详情、客户详情加维修记录；取机收款进日结和收银日报；碎屏险理赔过的服务不能退、单不能作废；`db:check` 第 7 类；演示数据约 430 张维修单（复查后补了作废单、延保老单，数据重新生成）。没做：备用机、外送、维修配件进销存、退换机审核。开工前在 d48f8be 打了稳定版标签 `demo-2026-10-20`（排练、录屏用）。
- 运营商业务（2026-10-20，剩余模块第 2 项）：口径第 14 节；四张表（迁移 `carrier_business`）；`src/lib/carrier.ts`（结算单 CSV 解析、按月对账，纯函数）、`src/server/carrier/carrier-service.ts`；页面 `/carrier`、`/carrier/new`、`/carrier/stats`、`/carrier/settlements`（+ 详情）、`/carrier/rules`；登记按政策快照预计佣金，店员只看、只确认自己经办的；总部导入结算单 CSV 对账（按受理单号、号码 + 业务类型），记实收、金额不符、没登记、漏给、返销；运营商没有接口，演示里“同步运营商状态”“生成模拟结算单”两个模拟器（只在演示模式）；佣金不进日结；`db:check` 第 8 类；演示数据约 580 笔、7～8 月已对账、9 月留给演示。没做：运营商系统真接口、号码库存、话费代收、员工提成（等人事模块）。
- 售后维修复查后补（2026-10-20）：报价后碎屏险、延保被退掉或被别的单先理赔、原销售单退了，取机前再核一遍付法（日期按第一次报价那天），不成立就在待取机的单上重新报价；接件提示带出客户名下不绑机器的碎屏险、延保；外面买的机器码统一存大写；演示数据取机时间不早于修好时间、加了约 10 张作废单。
- 运营商业务复查后补（2026-10-20）：对账按运营商排队（advisory 锁），结算、返销条件写入，两个月份同时导入同一笔只结算一次（并发测试）；第 8 类自检加“一笔业务最多拿一次佣金、最多返销一次”；受理单号同一运营商没作废的不重复（服务层校验 + 部分唯一索引），确认开通时也校验格式；模拟同步条件写入，不覆盖手动确认；结算单 CSV 一行最多 10 万元、佣金和返销同一行拒收；详情页漏给清单写明按现在算；根级 404 页改成按请求渲染（之前静态页脚本被 CSP 拦）；口径第 14 节补了几句。
- 国补（2026-10-20，剩余模块第 3 项）：口径第 15 节；两张表 + 收款方式加 SUBSIDY（迁移 `subsidy`）；`src/lib/subsidy.ts`（算补贴、挑哪台、资格码、平台结果表格，纯函数）、`src/server/subsidy/subsidy-service.ts`；开单页“这单用国补”（填资格码、核对国补、演示里模拟领取），服务层在开单事务里按客户排队再算一遍；作废、退货撤销国补单（到账的变需退回），退货只退顾客付的部分；日结和收银日报单列“国补立减”（自动对上，不算现金类）；页面 `/subsidy`（汇总 + 明细 + 提交审核 + 导入平台结果 + 模拟审核和到账 + 标已退回）、`/subsidy/policies`，销售单详情显示国补单；`db:check` 第 9 类；演示数据约 2000 张国补单（各状态都有）。没做：真对接各省平台、上传发票和串号照片、家电等品类、地方叠加补贴、手机开单用国补。
- 发票（2026-10-20，剩余模块第 4 项）：口径第 16 节；三张表（迁移 `invoices`，一单一张在办的、发票号码不重复两条部分唯一索引）；`src/lib/invoice.ts`（明细分摊、税额、抬头校验、号码，纯函数）、`src/server/invoice/invoice-service.ts`；页面 `/invoices`（汇总 + 列表）、`/invoices/new`、`/invoices/[id]`（开具、红冲、撤回、纸质票到店）、`/invoices/seller`；销售单详情“申请开票”和发票记录；退货、作废时待开票的自动撤回、已开票的标需红冲；国补单提交不填发票号就用这张单已开的号码；`db:check` 第 10 类；演示数据约 3500 张发票（国补单的发票号和发票对得上）。没做：真对接税控和数电票接口、PDF 版式、合并或拆分开票、进项发票。
- 发票复查后补（2026-10-20）：别店的发票详情、别店销售单的申请开票页显示无权限页（之前是出错页）；国补单被驳回重提时，记下的号已红冲就换成现在已开的号，手填已红冲的号拒；红字号码加部分唯一索引（迁移 `invoice_red_number_unique`），登记号码按号码排队检查，自检第 10 类查红字号重复和与发票号互撞；18 位纳税人识别号按统一社会信用代码查字符和校验位；演示数据加了撤回的申请、红冲后重开的、邮箱接收方，公司税号都是校验位正确的编造号码；本机 e2e 等开发服务器启动 240 秒。
- 国补复查后补（2026-10-20）：资格码加部分唯一索引（不同店同时用同一个码只成一张，撞约束换成人话）；政策日期校验真实日期；补贴算成 0 的不能用、提示说清；平台到账和补贴不一样的单列“到账差额”，导入时提示；发票号超 30 位报错不截断；退货提示只提本单真有的抵扣、国补；演示数据加了到账后退货的（需退回、已退回）。
- AI 智能提醒（2026-10-21，剩余模块第 7 项，分两次提交）：口径第 18 节。第一次提交是规则和推送（不接模型也能跑）：三张表和门店群机器人地址（迁移 `alerts`）；`src/lib/alerts.ts`（规则名和门槛、KPI 落后、调拨建议、模板版今日待办、按字节截断、群地址校验，纯函数）、`src/server/alerts/rules.ts`（十条规则，每条一个函数，按传进来的时间算；区域、总部是门店的汇总加调拨建议、要总部批的、对账自检）、`alert-service.ts`（runAlerts：存命中的、删已经没有的、每个范围写一份今日待办、发消息、推门店群；内容没变不重推）、`push.ts`（群机器人，ALERT_PUSH_ENABLED=1 才真发、只认官方地址、失败重试一次）；`pnpm alerts:run`（定时每天两次），`db:reset` 后也跑一遍；页面 `/alerts`、顶栏消息；组织管理门店加群机器人地址（只显示有没有填）。今日待办写法这次只有模板。
- 企业微信第三步（2026-10-20，剩余模块第 6 项，分三次提交）：口径第 12 节“企业微信第三步”写了侧边栏、微信客服、客户继承。第一次提交是聊天侧边栏：`src/server/wecom/sidebar-token.ts`（侧边栏自己的票：单独 cookie、只在 /wecom-app 下、2 小时、密钥从 SESSION_SECRET 派生另一把、带用途，ERP 登录票也拒收带用途的票）、`sidebar-service.ts`（票换人核对会话版本和企业微信账号；先核对是自己的好友再查画像；按完整手机号认领）、`/wecom-app/auth`（真对接走网页授权，模拟模式按已登录的 ERP 员工发票）、`/wecom-app/api/signature`（JS-SDK agentConfig 签名，应用票据落库缓存）、`/wecom-app/customer`（画像页，真对接时用 JS-SDK 拿当前客户）、`/wecom/sidebar`（模拟的企业微信聊天窗口）；`src/proxy.ts` 放行 /wecom-app、只它允许被本站框住。第二次提交是微信客服：三张表（迁移 `wecom_kf`）；`src/lib/wecom-kf.ts`（认意图、抽机型、找型号、48 小时 5 条、解析消息，纯函数）、`src/server/wecom/kf-service.ts`（回调 kf_msg_or_event 按游标拉消息、按消息 id 去重、规则答复、转人工、超限不发记下来、180 天清理）；回调分发加了 kf_msg_or_event，事件来源记 KF；模拟器 `simulateKfMessage`（新开老客户/新客户、接着发、接待人员回复、结束人工接待，都走真回调）；页面 `/wecom/kf`（总部）；每日任务清理客服消息；演示数据 40 个会话。第三次提交是客户继承：一张表（迁移 `wecom_transfers`，同一条跟进关系一个没办完的部分唯一索引）；`src/server/wecom/transfer-service.ts`（在职转接：锁跟进关系、店长只转本店、90 天 2 次、马上提交；离职继承：停用的员工才行，生成等删除成员的任务；processTransfers：删了人就提交、查结果，接替完毕原跟进关系标 TRANSFERRED、接手人名下建新的）；组织管理停用员工时选接手人（停用不等继承）；客户详情企业微信区“转接跟进人”；页面 `/wecom/transfers`（店长菜单“客户继承”，总部从企微对接进）；每日任务（真对接）推进继承；演示数据十来条在职转接。没做：自动打标、群发、按员工或门店的长期活码。
- 审批（2026-10-20，剩余模块第 5 项）：口径第 17 节；两张表（迁移 `approvals`，同一件事一张待审批的部分唯一索引）；`src/lib/approval.ts`（规则判断、谁能批，纯函数）、`src/server/approval/approval-check.ts`（各服务层动数据前调 checkApproval，触发就抛 ApprovalRequiredError；单独放一个文件免得循环引用）、`src/server/approval/approval-service.ts`（存审批单；通过时在一个事务里设保存点、以发起人身份带 approved 执行，做不成回到保存点记原因）；开单、退货、作废、调拨申请、盘点确认接上（调拨申请、盘点确认改出了事务版 createTransferTx、confirmStocktakeTx）；页面 `/approvals`、`/approvals/[id]`、`/approvals/rules`，开单、退货、作废、调拨、盘点触发了就跳到审批单；`db:check` 第 11 类；演示数据打开四条规则（店员让利超过 5%、退款 3000 元起要店长批，调拨 2 万起、盘亏 500 元起要总部批），带约 780 张历史审批单、几张待批的。没做：多级审批、会签、超时、消息推送。
- 延保改成从保修到期次日起算（2026-10-20 坤总在自检卡片上选的）：`entitlementPeriod`（`src/lib/entitlement.ts`）统一算生效日和到期日，开单生成权益用它；维修报价时延保要到生效日才能选，保修期内提示“X 起生效，先走保修”；客户详情显示“未生效”，销售单详情写明起止；演示数据每家店加 4 张一年多前买机器加延保的老单（到货、开单、收款，那几天补了已确认的日结，老客户建档早于开单，KPI 不算它们），延保付的维修单有几张。复查后补：延保要和机器同一张单买（单独补买这一版不做）；迁移 `extended_warranty_reminders` 删掉按旧到期日生成的延保提醒。
- 服务权益自检复查后补（2026-10-20）：退货页勾机器默认一起勾保它的服务；只退机器时权益记 `device_returned_at`（迁移 `entitlement_device_returned`），页面标“机器已退回”；演示数据退机器连服务一起退；到期名单文案改成实话（每日任务要配定时）；`db:check` 第 6 项加“权益门店、客户和销售单一致”“机器退了要记已退回”；演示脚本加 5a、5b 两步可选加演。到期日月底规则（1 月 28～31 日起保 1 个月都到 2 月 27 日）坤总已定保持现状（2026-10-20），取舍记录里写了原因。

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
- 迁移 `20261021270000_extended_warranty_reminders` 清旧延保提醒用的条件 `created_at < started_on` 只对 12 个月以内的延保准；以后加 24 个月这类延保 SKU 又要改到期规则，新迁移改用 `created_at < expires_on − 31 天`（已上的迁移不改，改了校验和会变）。
- 本机跑过 `pnpm build` 之后开发服务器页面不停刷新：生产构建和开发缓存打架，按第一条删 `.next` 重启。

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
- `pnpm daily`：每日任务（生成到期提醒；真对接企业微信时重放失败事件、清过期二维码配置），用 `tsx --conditions=react-server` 跑
- `pnpm db:reset`：清空全部业务表 → 基础种子 → 生成 3 个月模拟经营数据（只允许本机库，约 30 秒）
- `pnpm db:studio`：Prisma 自带的看表界面

## 已定的环境事实

- 本机数据库：PostgreSQL 17 Windows 服务 `postgresql-x64-17`，端口 5432，库 `dianyoushu_erp`，连接串在 `.env`（不提交）。
- `psql` 不在 PATH，用全路径 `C:\Program Files\PostgreSQL\17\bin\psql.exe`；图形界面用开始菜单的 pgAdmin 4。
- Prisma 7：`.env` 不会被 Prisma CLI 自动读，靠 `prisma.config.ts` 里的 `import "dotenv/config"`；Next.js 运行时自己会读 `.env`。
- 演示账号见 README，密码 `demo1234`。
- 改了 `schema.prisma` 后：`pnpm db:migrate`（已带 generate），然后**重启 `pnpm dev`**。开发服务器把 Prisma 客户端缓存在进程里，不重启会报 `Cannot read properties of undefined (reading 'create')`。
- antd `Modal` 不要加 `forceRender`：弹窗内容会在服务端预渲染，客户端又走 Portal，导致 hydration 不一致报错。
