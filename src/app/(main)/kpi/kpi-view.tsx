"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, InputNumber, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { formatFen, yuanToFen } from "@/lib/format";
import type { KpiRow } from "@/server/kpi/kpi-service";
import { saveKpiTargetsAction } from "./actions";

interface Draft {
  salesYuan: number | null;
  profitYuan: number | null;
  devices: number | null;
  tradeIns: number | null;
}

type Field = keyof Draft;

function toDraft(t: KpiRow["target"]): Draft {
  return t
    ? { salesYuan: t.salesTargetFen / 100, profitYuan: t.profitTargetFen / 100, devices: t.deviceQtyTarget, tradeIns: t.tradeInQtyTarget }
    : { salesYuan: null, profitYuan: null, devices: null, tradeIns: null };
}

const isEmpty = (d: Draft) => d.salesYuan === null && d.profitYuan === null && d.devices === null && d.tradeIns === null;
const isFull = (d: Draft) => d.salesYuan !== null && d.profitYuan !== null && d.devices !== null && d.tradeIns !== null;
const thousands = (v: number | string | undefined) => `${v ?? ""}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const unThousands = (v: string | undefined) => (v ?? "").replace(/,/g, "");

export function KpiView({ month, currentMonth, options, rows }: { month: string; currentMonth: string; options: string[]; rows: KpiRow[] }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [drafts, setDrafts] = useState<Record<number, Draft>>(() => Object.fromEntries(rows.map((r) => [r.storeId, toDraft(r.target)])));

  const [y, m] = month.split("-").map(Number) as [number, number];
  const filled = rows.filter((r) => !isEmpty(drafts[r.storeId]!)).length;
  const hasPrev = rows.some((r) => r.prevTarget);

  function update(storeId: number, field: Field, value: number | null) {
    setDrafts((prev) => ({ ...prev, [storeId]: { ...prev[storeId]!, [field]: value } }));
  }

  function copyPrevious() {
    let n = 0;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const r of rows) {
        if (r.prevTarget && isEmpty(next[r.storeId]!)) {
          next[r.storeId] = toDraft(r.prevTarget);
          n++;
        }
      }
      return next;
    });
    message.info(n > 0 ? `已把上月目标填进 ${n} 家还没填的门店，确认后点保存` : "没有可复制的：要么都填了，要么上月没目标");
  }

  function save() {
    const partial = rows.filter((r) => !isEmpty(drafts[r.storeId]!) && !isFull(drafts[r.storeId]!));
    if (partial.length > 0) return message.warning(`${partial[0]!.label} 四个数要填全`);
    const payload = rows
      .filter((r) => isFull(drafts[r.storeId]!))
      .map((r) => {
        const d = drafts[r.storeId]!;
        return { storeId: r.storeId, salesTargetFen: yuanToFen(d.salesYuan), profitTargetFen: yuanToFen(d.profitYuan), deviceQtyTarget: d.devices!, tradeInQtyTarget: d.tradeIns! };
      });
    if (payload.length === 0) return message.warning("还没填任何门店");
    startTransition(async () => {
      const result = await saveKpiTargetsAction(y, m, payload);
      if (result.ok) message.success(`已保存 ${result.saved} 家门店的 ${month} 目标`);
      else message.error(result.error);
    });
  }

  const moneyInput = (r: KpiRow, field: "salesYuan" | "profitYuan") => (
    <InputNumber
      min={0}
      precision={0}
      step={10000}
      style={{ width: 150 }}
      formatter={thousands}
      parser={unThousands}
      value={drafts[r.storeId]![field]}
      onChange={(v) => update(r.storeId, field, v === null ? null : Number(v))}
    />
  );
  const countInput = (r: KpiRow, field: "devices" | "tradeIns") => (
    <InputNumber min={0} precision={0} style={{ width: 100 }} value={drafts[r.storeId]![field]} onChange={(v) => update(r.storeId, field, v === null ? null : Number(v))} />
  );

  const columns: TableColumnsType<KpiRow> = [
    { title: "门店", dataIndex: "label", fixed: "left", width: 150 },
    { title: "区域", dataIndex: "region", width: 90 },
    { title: "销售额目标（元）", render: (_, r) => moneyInput(r, "salesYuan") },
    { title: "毛利目标（元）", render: (_, r) => moneyInput(r, "profitYuan") },
    { title: "主机台数", render: (_, r) => countInput(r, "devices") },
    { title: "回收台数", render: (_, r) => countInput(r, "tradeIns") },
    {
      title: "上月目标",
      render: (_, r) =>
        r.prevTarget ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            销 {formatFen(r.prevTarget.salesTargetFen)} / 毛 {formatFen(r.prevTarget.profitTargetFen)} / {r.prevTarget.deviceQtyTarget} 台 / 收 {r.prevTarget.tradeInQtyTarget}
          </Typography.Text>
        ) : (
          "-"
        ),
    },
    { title: "状态", width: 80, render: (_, r) => (r.target ? <Tag color="green">已定</Tag> : <Tag>未定</Tag>) },
  ];

  return (
    <Card
      title="KPI 目标"
      extra={
        <Space wrap>
          <Select value={month} style={{ width: 130 }} options={options.map((o) => ({ value: o, label: o === currentMonth ? `${o}（本月）` : o }))} onChange={(v) => router.push(`/kpi?month=${v}`)} />
          <Button onClick={copyPrevious} disabled={!hasPrev}>
            复制上月目标
          </Button>
          <Button type="primary" loading={pending} onClick={save}>
            保存
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        每家门店每月四个数。看板上的“KPI 完成率”和“每天还要卖多少”按当月目标算；没定目标的门店，看板上目标和完成率显示“-”。已填 {filled} / {rows.length} 家。
      </Typography.Paragraph>
      <Table rowKey="storeId" size="small" pagination={false} columns={columns} dataSource={rows} scroll={{ x: 1000 }} />
    </Card>
  );
}
