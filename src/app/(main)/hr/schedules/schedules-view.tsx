"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Popconfirm, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { addDays, dayLabel, LEAVE_KIND_LABELS, SHIFT_COLORS, SHIFT_KINDS, SHIFT_LABELS, shiftTimeText, type ShiftKindKey } from "@/lib/attendance";
import type { WeekSchedule } from "@/server/hr/schedule-service";
import { copyLastWeekAction, saveScheduleAction, type ScheduleActionResult } from "./actions";

type Employee = WeekSchedule["employees"][number];

const ROLE_LABELS: Record<string, string> = { STAFF: "店员", STORE_MANAGER: "店长" };

export function SchedulesView({ data }: { data: WeekSchedule }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  // 改过、还没保存的格子：key = 员工|日期，值为空表示清掉
  const [edits, setEdits] = useState<Record<string, ShiftKindKey | null>>({});
  const dirty = Object.keys(edits).length;

  function go(next: { week?: string; store?: number }) {
    if (dirty && !window.confirm("有没保存的排班，确定离开？")) return;
    setEdits({});
    const sp = new URLSearchParams();
    sp.set("week", next.week ?? data.weekStart);
    const store = next.store ?? data.storeId;
    if (store) sp.set("store", String(store));
    router.push(`/hr/schedules?${sp}`);
  }

  function act(fn: () => Promise<ScheduleActionResult>) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) return void message.error(r.error);
      message.success(r.message);
      setEdits({});
      router.refresh();
    });
  }

  function valueOf(userId: number, date: string): ShiftKindKey | null {
    const key = `${userId}|${date}`;
    return key in edits ? edits[key]! : ((data.cells as Record<string, ShiftKindKey>)[key] ?? null);
  }

  const inRange = (d: string) => d >= data.range.from && d <= data.range.to;
  // 店长：自己今天和以前的班不能改（找总部）
  const editable = (e: Employee, d: string) => data.canEdit && e.current && inRange(d) && !(e.id === data.selfId && data.selfLocked && d <= data.today);
  const columns: TableColumnsType<Employee> = [
    { title: "员工", fixed: "left", width: 120, render: (_, e) => <Space orientation="vertical" size={0}>{e.name}<Typography.Text type="secondary">{e.note ?? ROLE_LABELS[e.role] ?? ""}</Typography.Text></Space> },
    ...data.dates.map((d) => ({
      title: <Typography.Text strong={d === data.today}>{dayLabel(d)}</Typography.Text>,
      key: d,
      width: 120,
      render: (_: unknown, e: Employee) => {
        const key = `${e.id}|${d}`;
        const leave = (data.leaves as Record<string, keyof typeof LEAVE_KIND_LABELS>)[key];
        const value = valueOf(e.id, d);
        const other = (data.elsewhere as Record<string, string>)[key]; // 那天在别的店的班：这里只显示
        return (
          <Space orientation="vertical" size={2}>
            {other ? (
              <Typography.Text type="secondary">{other}</Typography.Text>
            ) : editable(e, d) ? (
              <Select
                size="small"
                allowClear
                placeholder="—"
                style={{ width: 96 }}
                value={value ?? undefined}
                options={SHIFT_KINDS.map((s) => ({ value: s, label: SHIFT_LABELS[s] }))}
                onChange={(v) => setEdits((prev) => ({ ...prev, [key]: v ?? null }))}
                variant={key in edits ? "filled" : "outlined"}
              />
            ) : value ? (
              <Tag color={SHIFT_COLORS[value]}>{SHIFT_LABELS[value]}</Tag>
            ) : (
              <Typography.Text type="secondary">—</Typography.Text>
            )}
            {leave ? <Tag color="gold">{LEAVE_KIND_LABELS[leave]}</Tag> : null}
          </Space>
        );
      },
    })),
  ];

  return (
    <Card
      title="排班"
      extra={
        data.canEdit && data.storeId ? (
          <Space wrap>
            <Popconfirm title="按上周排本周？本周已经排了的格子不动。" onConfirm={() => act(() => copyLastWeekAction(data.storeId!, data.weekStart))}>
              <Button loading={pending}>复制上周</Button>
            </Popconfirm>
            <Button type="primary" disabled={!dirty} loading={pending} onClick={() => act(() => saveScheduleAction(data.storeId!, Object.entries(edits).map(([k, shift]) => ({ userId: Number(k.split("|")[0]), date: k.split("|")[1]!, shift }))))}>
              保存{dirty ? `（${dirty} 格）` : ""}
            </Button>
          </Space>
        ) : null
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        {data.stores.length > 1 ? <Select style={{ width: 200 }} showSearch={{ optionFilterProp: "label" }} value={data.storeId ?? undefined} options={data.stores.map((s) => ({ value: s.id, label: `${s.code} ${s.name}` }))} onChange={(v) => go({ store: v })} /> : null}
        <Button onClick={() => go({ week: addDays(data.weekStart, -7) })}>上一周</Button>
        <Typography.Text>
          {data.dates[0]} ～ {data.dates[6]}
        </Typography.Text>
        <Button onClick={() => go({ week: addDays(data.weekStart, 7) })}>下一周</Button>
        <Button type="link" onClick={() => go({ week: data.today })}>
          回到本周
        </Button>
      </Space>
      <Typography.Paragraph type="secondary">
        按那天在哪家店算：调了店的人，以前在别的店的班显示成灰字，这里改不了。店长自己今天和以前的班找总部改；改今天以前的格子会按格记进操作日志。班次：{(["MORNING", "MIDDLE", "EVENING"] as const).map((s) => `${SHIFT_LABELS[s]} ${shiftTimeText(s)}`).join("，")}。{data.canEdit ? `能排 ${data.range.from} 到 ${data.range.to} 的班；改完点保存。` : "区域经理只看不改。"}黄色标签是批了的请假。
      </Typography.Paragraph>
      <Table rowKey="id" size="small" columns={columns} dataSource={data.employees} pagination={false} scroll={{ x: 1000 }} locale={{ emptyText: "这家店没有在职员工" }} />
    </Card>
  );
}
