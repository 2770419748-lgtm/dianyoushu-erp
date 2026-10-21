"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Card, DatePicker, Input, Modal, Popconfirm, Segmented, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import { APPROVER_ROLE_LABELS, type ApproverRoleKey } from "@/lib/approval";
import { LEAVE_HQ_DAYS, LEAVE_KIND_LABELS, LEAVE_KINDS, leaveDays, OA_STATUS_COLORS, OA_STATUS_LABELS, type LeaveKindKey, type OaStatusKey } from "@/lib/attendance";
import type { LeaveList, LeaveView } from "@/server/hr/leave-service";
import { cancelLeaveAction, submitLeaveAction, type LeaveActionResult } from "./actions";

type Row = LeaveList["rows"][number];

export function LeavesView({ data, status, month, today }: { data: LeaveList; status?: OaStatusKey; month: string | null; today: string }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ kind: LeaveKindKey; range: [string, string] | null; reason: string }>({ kind: "PERSONAL", range: null, reason: "" }); // 默认事假：选择框会高亮第一个，值也要真的设上

  function go(next: { view?: LeaveView; status?: OaStatusKey | null; month?: string | null; page?: number }) {
    const sp = new URLSearchParams();
    sp.set("view", next.view ?? data.view);
    const s = next.status === undefined ? status : next.status;
    if (s) sp.set("status", s);
    const m = next.month === undefined ? month : next.month;
    if (m) sp.set("month", m);
    if (next.page && next.page > 1) sp.set("page", String(next.page));
    router.push(`/hr/leaves?${sp}`);
  }

  function act(fn: () => Promise<LeaveActionResult>, after?: () => void) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) return void message.error(r.error);
      message.success(r.message, 5);
      after?.();
      router.refresh();
    });
  }

  const days = form.range ? leaveDays(form.range[0], form.range[1]) : 0;
  const columns: TableColumnsType<Row> = [
    ...(data.view === "team" ? [{ title: "员工", render: (_: unknown, r: Row) => r.name }, { title: "门店", dataIndex: "store" }] : []),
    { title: "类型", render: (_, r) => LEAVE_KIND_LABELS[r.kind] },
    { title: "日期", render: (_, r) => (r.startDate === r.endDate ? r.startDate : `${r.startDate} ～ ${r.endDate}`) },
    { title: "天数", dataIndex: "days", align: "right" },
    { title: "事由", dataIndex: "reason", render: (v: string) => <Typography.Text ellipsis={{ tooltip: v }} style={{ maxWidth: 260 }}>{v}</Typography.Text> },
    {
      title: "状态",
      render: (_, r) => (
        <Space orientation="vertical" size={0}>
          <Tag color={OA_STATUS_COLORS[r.status]}>{OA_STATUS_LABELS[r.status]}</Tag>
          {r.status === "PENDING" && r.approval ? <Typography.Text type="secondary">等{APPROVER_ROLE_LABELS[r.approval.approverRole as ApproverRoleKey]}批{r.approval.steps > 1 ? `（第 ${r.approval.step}/${r.approval.steps} 级）` : ""}</Typography.Text> : null}
          {r.approval?.note ? <Typography.Text type="secondary">{r.approval.note}</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: "",
      render: (_, r) => (
        <Space>
          {r.approval ? <Link href={`/approvals/${r.approval.id}`}>审批单</Link> : null}
          {r.mine && r.status === "PENDING" ? (
            <Popconfirm title="撤回这张请假？" onConfirm={() => act(() => cancelLeaveAction(r.id))}>
              <a>撤回</a>
            </Popconfirm>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="请假"
      extra={
        <Button type="primary" onClick={() => setOpen(true)}>
          我要请假
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">
        请假提交后走审批：店员请 1～2 天店长批，{LEAVE_HQ_DAYS} 天及以上店长批完总部再批；店长和总部的人直接总部批。批了的日子考勤算请假、不算缺勤。审批中的可以撤回，批了的不能撤。
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        {data.team ? <Segmented<LeaveView> value={data.view} options={[{ value: "mine", label: "我的" }, { value: "team", label: "员工的" }]} onChange={(v) => go({ view: v, page: 1 })} /> : null}
        <DatePicker picker="month" placeholder="按月份" value={month ? dayjs(`${month}-01`) : null} onChange={(d) => go({ month: d ? d.format("YYYY-MM") : null, page: 1 })} />
        <Select allowClear placeholder="状态" style={{ width: 120 }} value={status} options={(Object.keys(OA_STATUS_LABELS) as OaStatusKey[]).map((s) => ({ value: s, label: OA_STATUS_LABELS[s] }))} onChange={(v) => go({ status: v ?? null, page: 1 })} />
      </Space>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={data.rows}
        scroll={{ x: 900 }}
        locale={{ emptyText: "没有请假记录" }}
        pagination={{ current: data.page, pageSize: data.pageSize, total: data.total, showSizeChanger: false, hideOnSinglePage: true, onChange: (p) => go({ page: p }) }}
      />
      <Modal
        title="请假"
        open={open}
        confirmLoading={pending}
        onCancel={() => setOpen(false)}
        onOk={() => {
          if (!form.range) return void message.error("选一下请假日期");
          act(() => submitLeaveAction({ kind: form.kind, startDate: form.range![0], endDate: form.range![1], reason: form.reason }), () => {
            setOpen(false);
            setForm({ kind: "PERSONAL", range: null, reason: "" });
          });
        }}
        okText="提交审批"
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Segmented<LeaveKindKey> value={form.kind} options={LEAVE_KINDS.map((k) => ({ value: k, label: LEAVE_KIND_LABELS[k] }))} onChange={(v) => setForm({ ...form, kind: v })} />
          <DatePicker.RangePicker
            style={{ width: "100%" }}
            value={form.range ? [dayjs(form.range[0]), dayjs(form.range[1])] : null}
            disabledDate={(d) => d.isBefore(dayjs(today).subtract(31, "day"), "day")}
            onChange={(v) => setForm({ ...form, range: v && v[0] && v[1] ? [v[0].format("YYYY-MM-DD"), v[1].format("YYYY-MM-DD")] : null })}
          />
          {days ? <Typography.Text type="secondary">共 {days} 天（含首尾，按自然日）{days >= LEAVE_HQ_DAYS ? "，店员请这么多天要店长批完总部再批" : ""}</Typography.Text> : null}
          <Input.TextArea placeholder="事由（必填）" rows={3} maxLength={200} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </Space>
      </Modal>
    </Card>
  );
}
