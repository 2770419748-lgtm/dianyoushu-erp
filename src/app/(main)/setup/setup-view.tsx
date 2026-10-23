"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Checkbox, Descriptions, Form, Input, Space, Steps, Switch, Tag, Typography } from "antd";
import type { PaymentMethod } from "@/generated/prisma/enums";
import { LICENSE_PLAN_LABELS, type License, type LicenseState } from "@/lib/license";
import { PAYMENT_METHOD_LABELS } from "@/lib/sales-labels";
import type { Company, Switches } from "@/server/settings/settings-service";
import { markSetupDoneAction, saveCompanyAction, savePaymentMethodsAction, saveSwitchesAction, type SetupActionResult } from "./actions";

const STATE_LABELS: Record<LicenseState["kind"], string> = { demo: "演示", missing: "没开户", ok: "正常", expiring: "快到期", grace: "已到期（宽限期）", readonly: "已到期（只读）" };

// 系统设置 / 初始化向导（口径第 21 节）：按顺序一项项做；做没做完自动判断，公司信息、收款方式、业务开关就在这页改。
export function SetupView({
  demo,
  company,
  license,
  methods,
  allMethods,
  switches,
  done,
  counts,
}: {
  demo: boolean;
  company: Company | null;
  license: (License & { state: LicenseState["kind"] }) | null;
  methods: PaymentMethod[];
  allMethods: PaymentMethod[];
  switches: Switches;
  done: boolean;
  counts: { stores: number; users: number; products: number };
}) {
  const { message } = App.useApp();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<PaymentMethod[]>(methods);

  function act(fn: () => Promise<SetupActionResult>, ok: string) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) return void message.error(r.error);
      message.success(ok);
      router.refresh();
    });
  }

  const steps = [
    { title: "公司信息和小票抬头", done: company !== null },
    { title: "区域和门店", done: counts.stores > 0 },
    { title: "员工账号", done: counts.users > 0 },
    { title: "收款方式", done: true },
    { title: "业务开关", done: true },
    { title: "商品和期初库存", done: counts.products > 0 },
  ];
  const current = steps.findIndex((s) => !s.done);

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%", maxWidth: 820 }}>
      <Card title="开户信息">
        {demo ? (
          <Typography.Text type="secondary">演示站不管试用和到期。</Typography.Text>
        ) : license ? (
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2 }}
            items={[
              { key: "plan", label: "套餐", children: LICENSE_PLAN_LABELS[license.plan] },
              { key: "state", label: "状态", children: <Tag color={license.state === "ok" ? "green" : license.state === "expiring" ? "orange" : "red"}>{STATE_LABELS[license.state]}</Tag> },
              { key: "expires", label: "到期日", children: license.expiresOn },
              { key: "stores", label: "门店数上限", children: license.storeLimit === null ? "不限" : `${license.storeLimit} 家（在用 ${counts.stores} 家）` },
            ]}
          />
        ) : (
          <Alert type="error" showIcon title="还没有开户信息：请服务商在服务器上用 pnpm license:set 补上（库里已经有数据时不能再跑开户脚本）" />
        )}
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
          续费、改套餐、加门店数找给你开户的服务商（在服务器上改）。到期后 15 天照常用，之后只能查看和导出，数据不会自动删。
        </Typography.Paragraph>
      </Card>

      <Card
        title="初始化"
        extra={
          done ? (
            <Button size="small" loading={pending} onClick={() => act(() => markSetupDoneAction(false), "已重新打开初始化清单")}>
              重新打开清单
            </Button>
          ) : (
            <Button type="primary" size="small" loading={pending} disabled={!company} onClick={() => act(() => markSetupDoneAction(true), "初始化完成")}>
              完成初始化
            </Button>
          )
        }
      >
        {done ? (
          <Typography.Text type="secondary">已经完成初始化。下面的设置随时能改。</Typography.Text>
        ) : (
          <Steps
            orientation="vertical"
            size="small"
            current={current === -1 ? steps.length : current}
            items={steps.map((s) => ({ title: s.title, status: s.done ? "finish" : undefined }))}
          />
        )}
      </Card>

      <Card title="1 公司信息和小票抬头">
        <Form
          layout="vertical"
          initialValues={company ?? undefined}
          onFinish={(v: { name: string; receiptTitle?: string; phone?: string; address?: string }) => act(() => saveCompanyAction(v), "公司信息已保存")}
        >
          <Form.Item name="name" label="公司名" rules={[{ required: true, whitespace: true, message: "填公司名" }]}>
            <Input maxLength={40} placeholder="营业执照上的名字，或者门店统一的招牌名" />
          </Form.Item>
          <Form.Item name="receiptTitle" label="小票抬头" extra="打小票、保修卡时印在最上面；不填就用公司名">
            <Input maxLength={40} />
          </Form.Item>
          <Space wrap>
            <Form.Item name="phone" label="联系电话">
              <Input maxLength={30} style={{ width: "min(220px, 75vw)" }} />
            </Form.Item>
            <Form.Item name="address" label="地址">
              <Input maxLength={100} style={{ width: "min(360px, 75vw)" }} />
            </Form.Item>
          </Space>
          <Button type="primary" htmlType="submit" loading={pending}>
            保存
          </Button>
        </Form>
      </Card>

      <Card title="2 区域和门店　3 员工账号">
        <Typography.Paragraph>
          现在有在用门店 {counts.stores} 家、员工账号 {counts.users} 个（不算总部）。在组织管理里先建区域、门店，再给每家店建店长、店员账号；店多、人多的用 Excel 一次导进来。新账号第一次登录要先改密码。
        </Typography.Paragraph>
        <Space wrap>
          <Link href="/org">
            <Button>去组织管理</Button>
          </Link>
          <Link href="/setup/import">
            <Button>用 Excel 导入门店、员工</Button>
          </Link>
        </Space>
      </Card>

      <Card title="4 收款方式">
        <Typography.Paragraph type="secondary">门店开单时能选哪几种。以旧换新抵扣、国补立减是系统按单据自动生成的，不在这里。</Typography.Paragraph>
        <Checkbox.Group value={picked} onChange={(v) => setPicked(v as PaymentMethod[])} options={allMethods.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }))} />
        <div style={{ marginTop: 12 }}>
          <Button type="primary" loading={pending} disabled={picked.length === 0} onClick={() => act(() => savePaymentMethodsAction(picked), "收款方式已保存")}>
            保存
          </Button>
        </div>
      </Card>

      <Card title="5 业务开关">
        <Space orientation="vertical">
          <Space>
            <Switch checked={switches.tradeInIdRequired} loading={pending} onChange={(v) => act(() => saveSwitchesAction({ tradeInIdRequired: v }), v ? "回收登记身份证改成必填" : "回收登记身份证改成选填")} />
            <span>回收旧手机必须登记卖家身份证（很多地方收旧手机要求登记）</span>
          </Space>
          <span>
            审批规则（让利、低于成本卖、大额退款、作废、大额调拨、盘亏要不要审批）：<Link href="/approvals/rules">去审批规则</Link>
          </span>
        </Space>
      </Card>

      <Card title="6 商品和期初库存">
        <Typography.Paragraph>
          现在有商品 {counts.products} 个（不算服务和回收用的“其他机型”）。先从机型库里勾选要卖的机型（或者用 Excel 导商品），再把在库的机器、配件数量导进来，生成期初入库单；客户名单也可以导。
        </Typography.Paragraph>
        <Space wrap>
          <Link href="/products/library">
            <Button>从机型库添加商品</Button>
          </Link>
          <Link href="/setup/import">
            <Button type="primary">数据导入</Button>
          </Link>
        </Space>
      </Card>
    </Space>
  );
}
