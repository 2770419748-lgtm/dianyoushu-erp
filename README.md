# 店有数 ERP

[![CI](https://github.com/2770419748-lgtm/dianyoushu-erp/actions/workflows/ci.yml/badge.svg)](https://github.com/2770419748-lgtm/dianyoushu-erp/actions/workflows/ci.yml)

手机零售门店经营系统的演示版：从采购入库、串号库存、门店开单（含以旧换新）到收银日结、经营看板，一条业务链跑通。

给谁看：应聘时给面试官当场演示，证明能把门店业务做成多人可用、带权限、带完整业务链的系统；也是以后真做系统时的骨架。和桌面版"店有数"（仓库 `dianyoushu`）是两个项目：桌面版在门店单机用，店有数 ERP 是多人版。

## 状态

2026-10-16 启动，按 12 周任务清单推进，现在做完第 10 周（手机开单、扫码、KPI、后续规划、PWA、本机备份）。详细进度见 `PROJECT_STATE.md`。

## 技术路线

Next.js（App Router）+ Prisma + PostgreSQL + Ant Design，TypeScript 全栈，单仓库单进程；手机端做自适应网页，不做 App。

## 本地运行

1. 装好 Node 24、pnpm、PostgreSQL 17，在 PostgreSQL 里建一个空库 `dianyoushu_erp`。
2. 把 `.env.example` 复制一份改名 `.env`，填上数据库密码。
3. `pnpm install`（装完会自动生成 Prisma 客户端）。
4. `pnpm db:migrate` 建表。
5. `pnpm db:reset` 灌入模拟数据：3 个区域、10 家门店、100 个员工（含演示账号），再生成截至昨天 3 个月的经营数据，约 30 秒。
6. `pnpm dev`，浏览器打开 http://localhost:3000 。

常用命令见 `PROJECT_STATE.md`，开发规则见 `AGENTS.md`，备份恢复见 `docs/备份与恢复.md`，安全基线见 `docs/安全基线.md`，10 分钟演示怎么走见 `docs/演示脚本.md`。

## 手机上测试

手机浏览器只在 HTTPS 页面里给摄像头，扫码要这样开：

1. 电脑和手机连同一个 Wi-Fi。
2. 关掉 `pnpm dev`，改跑 `pnpm dev:https`。第一次会用 openssl（装了 Git for Windows 就有）给电脑的局域网 IP 签一张本机测试证书，不装根证书、不改系统设置。
3. 手机浏览器打开终端里打印的地址（例如 `https://192.168.1.8:3000`），提示“不安全”时点“高级 → 继续访问”。Windows 弹防火墙提示选“允许”。
4. 登录后点首页的“手机开单”或“查库存”，点“扫码”对准串号条码。想像 App 一样用：浏览器菜单里选“添加到主屏幕”。

## 演示账号

密码都是 `demo1234`。这 4 个账号受保护，不能被改密码、停用或改角色；想试这些功能先用 `hq` 新建一个员工。

| 账号 | 角色 | 能看什么 |
|---|---|---|
| `hq` | 总部 | 全部门店 |
| `regional` | 区域经理 | 华东区 4 家店 |
| `manager` | 店长 | S001 中山路店 |
| `staff` | 店员 | S001 中山路店 |
