# 店有数 ERP

手机零售门店经营系统的演示版：从采购入库、串号库存、门店开单（含以旧换新）到收银日结、经营看板，一条业务链跑通。

给谁看：应聘时给面试官当场演示，证明能把门店业务做成多人可用、带权限、带完整业务链的系统；也是以后真做系统时的骨架。和桌面版"店有数"（仓库 `dianyoushu`）是两个项目：桌面版在门店单机用，店有数 ERP 是多人版。

## 状态

2026-10-16 启动，第 1 周：口径、数据表、脚手架。进度见仓库根目录 `PROJECT_STATE.md`（第 4 天起）。

## 技术路线

Next.js（App Router）+ Prisma + PostgreSQL + Ant Design，TypeScript 全栈，单仓库单进程；手机端做自适应网页，不做 App。

## 本地运行

1. 装好 Node 24、pnpm、PostgreSQL 17，在 PostgreSQL 里建一个空库 `dianyoushu_erp`。
2. 把 `.env.example` 复制一份改名 `.env`，填上数据库密码。
3. `pnpm install`（装完会自动生成 Prisma 客户端）。
4. `pnpm db:migrate` 建表。
5. `pnpm db:seed` 灌入演示账号和示范门店。
6. `pnpm dev`，浏览器打开 http://localhost:3000 。

常用命令见 `PROJECT_STATE.md`，开发规则见 `AGENTS.md`。

## 演示账号

密码都是 `demo1234`（演示用，上线前会换并每日自动重置）。

| 账号 | 角色 | 能看什么 |
|---|---|---|
| `hq` | 总部 | 全部门店 |
| `regional` | 区域经理 | 华东区（示范一店、示范二店） |
| `manager` | 店长 | 示范一店 |
| `staff` | 店员 | 示范一店 |
