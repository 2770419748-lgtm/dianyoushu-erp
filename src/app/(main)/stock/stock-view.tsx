"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Input, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import type { DeviceStatus } from "@/generated/prisma/enums";
import { formatDateTime, formatFen } from "@/lib/format";
import { DEVICE_STATUS_COLORS, DEVICE_STATUS_LABELS } from "@/lib/stock-labels";
import type { AccessoryStockRow, DeviceRow } from "@/server/stock/stock-query";

interface Query {
  storeId?: number;
  q: string;
  status?: DeviceStatus;
  tab: "devices" | "accessories";
  page: number;
}

const STATUS_OPTIONS = (Object.keys(DEVICE_STATUS_LABELS) as DeviceStatus[]).map((s) => ({ value: s, label: DEVICE_STATUS_LABELS[s] }));

export function StockView({
  stores,
  query,
  devices,
  accessories,
  summary,
  showCost,
}: {
  stores: { id: number; label: string }[];
  query: Query;
  devices: { rows: DeviceRow[]; total: number; page: number; pageSize: number };
  accessories: AccessoryStockRow[];
  summary: { byStatus: Partial<Record<DeviceStatus, number>>; accessoryQty: number };
  showCost: boolean;
}) {
  const router = useRouter();

  function navigate(next: Partial<Query>) {
    const merged = { ...query, ...next };
    const sp = new URLSearchParams();
    if (merged.tab !== "devices") sp.set("tab", merged.tab);
    if (merged.storeId) sp.set("storeId", String(merged.storeId));
    if (merged.q) sp.set("q", merged.q);
    if (merged.status) sp.set("status", merged.status);
    if (merged.page > 1) sp.set("page", String(merged.page));
    router.push(`/stock${sp.size ? `?${sp}` : ""}`);
  }

  const deviceColumns: TableColumnsType<DeviceRow> = [
    { title: "主码", dataIndex: "code", fixed: "left", render: (code: string) => <Link href={`/stock/devices/${code}`}>{code}</Link> },
    {
      title: "其他码",
      render: (_, d) =>
        [d.sn && d.sn !== d.code ? `SN ${d.sn}` : null, d.imei2 ? `IMEI2 ${d.imei2}` : null].filter(Boolean).join(" / ") || "-",
    },
    { title: "商品", render: (_, d) => d.sku.name },
    { title: "品牌 / 型号", render: (_, d) => `${d.sku.model.brand.name} ${d.sku.model.name}` },
    { title: "门店", render: (_, d) => `${d.store.code} ${d.store.name}` },
    { title: "状态", dataIndex: "status", render: (s: DeviceStatus) => <Tag color={DEVICE_STATUS_COLORS[s]}>{DEVICE_STATUS_LABELS[s]}</Tag> },
    ...(showCost ? [{ title: "成本（元）", dataIndex: "costFen", align: "right" as const, render: (v: number) => formatFen(v) }] : []),
    { title: "更新时间", dataIndex: "updatedAt", render: (v: Date) => formatDateTime(v) },
  ];

  const accessoryColumns: TableColumnsType<AccessoryStockRow> = [
    { title: "商品", render: (_, a) => a.sku.name },
    { title: "品牌 / 型号", render: (_, a) => `${a.sku.model.brand.name} ${a.sku.model.name}` },
    { title: "门店", render: (_, a) => `${a.store.code} ${a.store.name}` },
    {
      title: "数量",
      dataIndex: "qty",
      align: "right",
      render: (v: number, a) =>
        a.sku.safetyQty > 0 && v < a.sku.safetyQty ? (
          <Space size={4}>
            <Tag color="red">{v}</Tag>
            <Typography.Text type="danger">低于安全库存 {a.sku.safetyQty}</Typography.Text>
          </Space>
        ) : v <= 0 ? (
          <Tag color="red">{v}</Tag>
        ) : (
          v
        ),
    },
    { title: "更新时间", dataIndex: "updatedAt", render: (v: Date) => formatDateTime(v) },
  ];

  return (
    <Card title="门店库存">
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          allowClear={stores.length > 1}
          placeholder="全部门店"
          // 只能看一家店的人（店员、店长）直接显示这家店，别显示成“全部门店”
          value={stores.length === 1 ? stores[0]!.id : query.storeId}
          style={{ width: 220 }}
          showSearch
          optionFilterProp="label"
          options={stores.map((s) => ({ value: s.id, label: s.label }))}
          onChange={(value) => navigate({ storeId: value, page: 1 })}
          disabled={stores.length === 1}
        />
        <Input.Search allowClear placeholder="搜串号、商品名或型号" defaultValue={query.q} style={{ width: 260 }} onSearch={(value) => navigate({ q: value, page: 1 })} />
        {query.tab === "devices" ? (
          <Select allowClear placeholder="状态" value={query.status} style={{ width: 120 }} options={STATUS_OPTIONS} onChange={(value) => navigate({ status: value, page: 1 })} />
        ) : null}
      </Space>
      <Space wrap style={{ marginBottom: 12 }}>
        {(Object.keys(DEVICE_STATUS_LABELS) as DeviceStatus[]).map((s) =>
          summary.byStatus[s] ? (
            <Tag key={s} color={DEVICE_STATUS_COLORS[s]}>
              {DEVICE_STATUS_LABELS[s]} {summary.byStatus[s]} 台
            </Tag>
          ) : null,
        )}
        <Typography.Text type="secondary">配件合计 {summary.accessoryQty} 件</Typography.Text>
      </Space>
      <Tabs
        activeKey={query.tab}
        onChange={(key) => navigate({ tab: key as Query["tab"], page: 1 })}
        items={[
          {
            key: "devices",
            label: `串号库存（${devices.total}）`,
            children: (
              <Table
                rowKey="id"
                size="small"
                columns={deviceColumns}
                dataSource={devices.rows}
                scroll={{ x: true }}
                pagination={{ current: devices.page, pageSize: devices.pageSize, total: devices.total, showSizeChanger: false, onChange: (p) => navigate({ page: p }) }}
              />
            ),
          },
          {
            key: "accessories",
            label: `配件库存（${accessories.length}）`,
            children: <Table rowKey="id" size="small" columns={accessoryColumns} dataSource={accessories} scroll={{ x: true }} pagination={{ pageSize: 20, showSizeChanger: false }} />,
          },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
        所有增减都在 <Link href="/stock/ledger">库存流水</Link> 里有记录；点串号能看这台机器从入库到现在的全程。
      </Typography.Paragraph>
    </Card>
  );
}
