"use client";

import Link from "next/link";
import { Card, Descriptions, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import type { SalesOrderStatus } from "@/generated/prisma/enums";
import { entitlementStateLabel, REMINDER_T30_MAX_DAYS } from "@/lib/entitlement";
import { formatDate, formatDateTime, formatFen } from "@/lib/format";
import { SALES_STATUS_COLORS, SALES_STATUS_LABELS } from "@/lib/sales-labels";
import type { CustomerDetail } from "@/server/customers/customer-service";
import type { CustomerEntitlement } from "@/server/entitlement/entitlement-service";
import type { CustomerWecom } from "@/server/wecom/contact-service";
import type { RepairHistoryRow } from "@/server/repair/repair-service";
import { RepairHistory } from "../../repairs/repair-history";
import { WecomTransferButton } from "./wecom-transfer-button";

type OrderRow = CustomerDetail["orders"][number];

const STATE_COLORS: Record<string, string> = { 保障中: "green", 即将到期: "orange", 未生效: "blue", 已过期: "default", 已失效: "default", 已理赔: "purple" };

type FollowRow = CustomerWecom["follows"][number];

const TAG_SOURCE_LABELS: Record<string, string> = { AUTO: "系统", MANUAL: "员工", WECOM: "企业微信" };

export function CustomerDetailView({ detail, wecom, repairs, transferTargets = [] }: { detail: CustomerDetail; wecom: CustomerWecom | null; repairs: RepairHistoryRow[]; transferTargets?: { id: number; label: string }[] }) {
  const { customer, orders, orderCount, entitlements } = detail;

  const entitlementColumns: TableColumnsType<CustomerEntitlement> = [
    { title: "服务", render: (_, e) => e.sku.name },
    {
      title: "保的机器",
      render: (_, e) =>
        e.device ? (
          <Space size={4}>
            <Link href={`/stock/devices/${e.device.code}`}>{e.device.code}</Link>
            {e.deviceReturnedAt ? <Tag>机器已退回</Tag> : null}
          </Space>
        ) : (
          "-"
        ),
    },
    { title: "门店", render: (_, e) => `${e.store.code} ${e.store.name}` },
    { title: "生效日", dataIndex: "startedOn", render: (v: Date) => formatDate(v) },
    { title: "到期日", dataIndex: "expiresOn", render: (v: Date) => formatDate(v) },
    {
      title: "剩余",
      align: "right",
      render: (_, e) =>
        e.status !== "ACTIVE" || e.daysLeft < 0 ? "-" : <Typography.Text type={e.daysLeft <= REMINDER_T30_MAX_DAYS ? "danger" : undefined}>{e.daysLeft} 天</Typography.Text>,
    },
    {
      title: "状态",
      render: (_, e) => {
        const label = entitlementStateLabel(e.status, e.daysLeft, e.daysToStart);
        return <Tag color={STATE_COLORS[label]}>{label}</Tag>;
      },
    },
  ];

  const orderColumns: TableColumnsType<OrderRow> = [
    { title: "日期", dataIndex: "bizDate", render: (v: Date) => formatDate(v) },
    { title: "单号", render: (_, o) => (o.id ? <Link href={`/sales/${o.id}`}>{o.orderNo}</Link> : <Typography.Text type="secondary">别人开的单</Typography.Text>) },
    { title: "门店", dataIndex: "store" },
    { title: "商品", dataIndex: "summary" },
    { title: "金额（元）", dataIndex: "totalFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "开单人", dataIndex: "salesperson", render: (v: string | null) => v ?? "-" },
    { title: "状态", dataIndex: "status", render: (s: SalesOrderStatus) => <Tag color={SALES_STATUS_COLORS[s]}>{SALES_STATUS_LABELS[s]}</Tag> },
  ];

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card title={`客户：${customer.name}`} extra={<Link href="/customers">回客户列表</Link>}>
        <Descriptions
          column={{ xs: 1, sm: 2, md: 3 }}
          items={[
            { key: "phone", label: "手机号", children: customer.phoneMasked },
            { key: "note", label: "备注", children: customer.note ?? "-" },
            { key: "created", label: "建档时间", children: formatDateTime(customer.createdAt) },
            { key: "orders", label: "下单次数", children: orderCount },
            { key: "active", label: "保障中的服务", children: entitlements.filter((e) => e.status === "ACTIVE" && e.daysLeft >= 0).length },
          ]}
        />
      </Card>

      <Card title={`碎屏险和延保（${entitlements.length}）`}>
        <Typography.Paragraph type="secondary">开单时卖的服务自动记在这里；退掉服务或单作废后变“已失效”。剩 30 天以内标红，会进到期名单。</Typography.Paragraph>
        <Table rowKey="id" size="small" columns={entitlementColumns} dataSource={entitlements} pagination={false} scroll={{ x: true }} locale={{ emptyText: "没有买过碎屏险、延保" }} />
      </Card>

      {wecom ? <WecomSection wecom={wecom} transferTargets={transferTargets} /> : null}

      {repairs.length > 0 ? <RepairHistory rows={repairs} /> : null}

      <Card title={`买过的单（${orderCount}${orderCount > orders.length ? `，显示最近 ${orders.length} 张` : ""}）`}>
        <Typography.Paragraph type="secondary">客户全公司共享：别的门店、别的店员开的单也列出来，但只显示摘要，打不开明细。</Typography.Paragraph>
        <Table rowKey="key" size="small" columns={orderColumns} dataSource={orders} pagination={false} scroll={{ x: true }} />
      </Card>
    </Space>
  );
}

/** 企业微信区：绑定状态、跟进人（按口径第 12 节只显示你看得到的）、标签 */
function WecomSection({ wecom, transferTargets }: { wecom: CustomerWecom; transferTargets: { id: number; label: string }[] }) {
  const columns: TableColumnsType<FollowRow> = [
    { title: "跟进员工", dataIndex: "staff" },
    { title: "门店", dataIndex: "store", render: (v: string | null) => v ?? "-" },
    { title: "加好友时间", dataIndex: "firstAddAt", render: (v: Date) => formatDateTime(v) },
    {
      title: "状态",
      render: (_, f) =>
        f.status === "ACTIVE" ? (
          <Tag color="green">跟进中</Tag>
        ) : (
          <Tag>{f.deletedBy === "EMPLOYEE" ? "员工删了客户" : f.deletedBy === "TRANSFERRED" ? "已转给别人" : "客户删了员工"}{f.deletedAt ? ` · ${formatDate(f.deletedAt)}` : ""}</Tag>
        ),
    },
    ...(wecom.follows.some((f) => f.canTransfer || f.transferring)
      ? [
          {
            title: "转接",
            render: (_: unknown, f: FollowRow) =>
              f.transferring ? (
                <Tag color="orange">{f.transferring.status === "WAITING_DELETE" ? "等删除成员" : "转接中"} → {f.transferring.to}</Tag>
              ) : f.canTransfer ? (
                <WecomTransferButton followId={f.id} staff={f.staff} targets={transferTargets.filter((t) => t.id !== f.staffId)} />
              ) : null,
          },
        ]
      : []),
  ];
  return (
    <Card title="企业微信">
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Typography.Text>
          {wecom.bound
            ? `已加企业微信${wecom.bound.nickname ? `（微信昵称：${wecom.bound.nickname}）` : ""}${wecom.bound.boundAt ? `，${formatDateTime(wecom.bound.boundAt)} 绑定` : ""}`
            : "还没加企业微信：开单后在销售单详情里生成二维码，客户扫码加店员就会绑上。"}
        </Typography.Text>
        {wecom.tags.length > 0 ? (
          <Space wrap size={4}>
            {wecom.tags.map((t) => (
              <Tag key={`${t.group}-${t.name}`} color="blue">
                {t.group}：{t.name}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}> {TAG_SOURCE_LABELS[t.source]}</Typography.Text>
              </Tag>
            ))}
          </Space>
        ) : null}
        <Table rowKey="id" size="small" columns={columns} dataSource={wecom.follows} pagination={false} scroll={{ x: true }} locale={{ emptyText: "没有你能看到的跟进关系" }} />
        {wecom.hiddenFollows > 0 ? <Typography.Text type="secondary">还有 {wecom.hiddenFollows} 条别的门店员工的跟进关系，按权限不显示。</Typography.Text> : null}
      </Space>
    </Card>
  );
}
