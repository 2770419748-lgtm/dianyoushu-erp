"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Col, DatePicker, Descriptions, Drawer, Input, Modal, Popconfirm, Row, Segmented, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import { SimpleList } from "@/components/simple-list";
import { bjMinuteOfDay, dayLabel, LEAVE_KIND_LABELS, minuteText, PUNCH_LABELS, SHIFT_COLORS, SHIFT_LABELS, shiftTimeText, type PunchKindKey } from "@/lib/attendance";
import type { getMyToday, MonthStats, UserMonthDetail } from "@/server/hr/attendance-service";
import { manualPunchAction, punchAction, type AttendanceActionResult } from "./actions";

type Today = Awaited<ReturnType<typeof getMyToday>>;
type Row = MonthStats["rows"][number];

function timeOf(at: Date | string): string {
  return minuteText(bjMinuteOfDay(new Date(at)));
}

export function AttendanceView({ today, stats, targets, detail, detailUserId, detailError }: { today: Today; stats: MonthStats; targets: { id: number; label: string }[]; detail: UserMonthDetail | null; detailUserId: number | null; detailError: string | null }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState<{ userId?: number; date: string; kind: PunchKindKey; time: string; note: string }>({ date: today.date, kind: "IN", time: "09:00", note: "" });

  function act(fn: () => Promise<AttendanceActionResult>, after?: () => void) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) return void message.error(r.error);
      message.success(r.message, 4);
      after?.();
      router.refresh();
    });
  }

  function go(next: { month?: string; store?: number | null; user?: number | null }) {
    const sp = new URLSearchParams();
    sp.set("month", next.month ?? stats.month);
    const store = next.store === undefined ? stats.storeId : next.store;
    if (store) sp.set("store", String(store));
    const user = next.user === undefined ? detailUserId : next.user;
    if (user) sp.set("user", String(user));
    router.push(`/hr/attendance?${sp}`);
  }

  const shift = today.day.shift;
  const columns: TableColumnsType<Row> = [
    {
      title: "员工",
      render: (_, r) => (
        <Space size={4}>
          <a onClick={() => go({ user: r.userId })}>{r.name}</a>
          {r.note ? <Tag>{r.note}</Tag> : null}
        </Space>
      ),
    },
    ...(stats.team ? [{ title: "门店", dataIndex: "store" }] : []),
    { title: "应出勤", align: "right", render: (_, r) => r.summary.scheduled },
    { title: "实际出勤", align: "right", render: (_, r) => r.summary.attended },
    { title: "迟到", align: "right", render: (_, r) => (r.summary.late ? <Typography.Text type="warning">{r.summary.late}</Typography.Text> : 0) },
    { title: "早退", align: "right", render: (_, r) => (r.summary.early ? <Typography.Text type="warning">{r.summary.early}</Typography.Text> : 0) },
    { title: "缺卡", align: "right", render: (_, r) => (r.summary.missing ? <Typography.Text type="warning">{r.summary.missing}</Typography.Text> : 0) },
    { title: "缺勤", align: "right", render: (_, r) => (r.summary.absent ? <Typography.Text type="danger">{r.summary.absent}</Typography.Text> : 0) },
    { title: "请假天数", align: "right", render: (_, r) => r.summary.leaveDays },
    { title: "加班天数", align: "right", render: (_, r) => r.summary.overtimeDays },
  ];

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card title={`今天 ${dayLabel(today.date)}`}>
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Space wrap>
                {today.day.leave ? <Tag color="gold">{LEAVE_KIND_LABELS[today.day.leave]}</Tag> : shift ? <Tag color={SHIFT_COLORS[shift]}>{SHIFT_LABELS[shift]}</Tag> : <Tag>没排班</Tag>}
                {shift && shift !== "OFF" ? <Typography.Text type="secondary">{shiftTimeText(shift)}</Typography.Text> : null}
              </Space>
              <Typography.Text>{today.day.label}</Typography.Text>
              {today.punches.length ? (
                <Typography.Text type="secondary">
                  已打卡：{today.punches.map((p) => `${PUNCH_LABELS[p.kind]} ${timeOf(p.at)}${p.manual ? "（补录）" : ""}`).join("，")}
                </Typography.Text>
              ) : null}
              <Row gutter={12}>
                <Col span={12}>
                  <Button type="primary" size="large" block disabled={today.hasIn} loading={pending} onClick={() => act(() => punchAction("IN"))} style={{ height: 64, fontSize: 18 }}>
                    {today.hasIn ? "已打上班卡" : "上班打卡"}
                  </Button>
                </Col>
                <Col span={12}>
                  {today.hasIn ? (
                    <Button size="large" block loading={pending} onClick={() => act(() => punchAction("OUT"))} style={{ height: 64, fontSize: 18 }}>
                      下班打卡
                    </Button>
                  ) : (
                    <Popconfirm title="今天还没打上班卡，确定现在打下班卡？" description="早上来了要点“上班打卡”；上班卡之前的下班卡不算数。" okText="确定下班" onConfirm={() => act(() => punchAction("OUT"))}>
                      <Button size="large" block loading={pending} style={{ height: 64, fontSize: 18 }}>
                        下班打卡
                      </Button>
                    </Popconfirm>
                  )}
                </Col>
              </Row>
              <Typography.Text type="secondary">按当天的班、按整分钟算：上班晚 5 分钟以上算迟到（9:05 不算、9:06 算），下班早 5 分钟以上算早退；下班卡可以重复打，以上班卡之后最晚的一次为准。漏打了找店长补录。</Typography.Text>
            </Space>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title="我本周的班">
            <SimpleList
              items={today.week}
              rowKey={(d) => d.date}
              render={(d) => (
                <Space>
                  <Typography.Text strong={d.isToday}>{dayLabel(d.date)}</Typography.Text>
                  {d.leave ? <Tag color="gold">{LEAVE_KIND_LABELS[d.leave]}</Tag> : d.shift ? <Tag color={SHIFT_COLORS[d.shift]}>{SHIFT_LABELS[d.shift]}</Tag> : <Typography.Text type="secondary">没排班</Typography.Text>}
                  {d.shift && d.shift !== "OFF" && !d.leave ? <Typography.Text type="secondary">{shiftTimeText(d.shift)}</Typography.Text> : null}
                </Space>
              )}
            />
            <Space style={{ marginTop: 8 }}>
              <Link href="/hr/leaves">去请假</Link>
            </Space>
          </Card>
        </Col>
      </Row>

      <Card
        title="月度考勤"
        extra={
          stats.canManage ? (
            <Button onClick={() => setManualOpen(true)} disabled={targets.length === 0}>
              补卡
            </Button>
          ) : null
        }
      >
        <Space wrap style={{ marginBottom: 12 }}>
          <DatePicker picker="month" allowClear={false} value={dayjs(`${stats.month}-01`)} onChange={(d) => d && go({ month: d.format("YYYY-MM"), user: null })} />
          {stats.team && stats.stores.length > 1 ? (
            <Select allowClear placeholder="全部门店" style={{ width: 200 }} value={stats.storeId ?? undefined} options={stats.stores.map((s) => ({ value: s.id, label: `${s.code} ${s.name}` }))} onChange={(v) => go({ store: v ?? null, user: null })} />
          ) : null}
        </Space>
        <Table rowKey="userId" size="small" columns={columns} dataSource={stats.rows} pagination={{ pageSize: 50, hideOnSinglePage: true }} scroll={{ x: 900 }} locale={{ emptyText: "没有员工" }} />
        <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
          应出勤按排了上班（早、中、晚班）的天数算，本月只算到今天；排了班一次都没打算缺勤，只打了一次算缺卡；批了的请假不算缺勤；休息日打卡算加班，只记录不算钱。按那天在哪家店算：调了店的人，每家店只算他在这家店的日子；停用、调走的人在他上过班的月份照样列出来。点名字看每天的明细。
        </Typography.Paragraph>
      </Card>

      <Drawer title={detail ? `${detail.name} ${stats.month} 考勤明细` : "考勤明细"} open={detailUserId !== null} size={560} onClose={() => go({ user: null })}>
        {detailError ? <Alert type="warning" title={detailError} /> : null}
        {detail ? (
          <Space orientation="vertical" style={{ width: "100%" }}>
            <Descriptions
              size="small"
              column={2}
              items={[
                { key: "s", label: "应出勤", children: detail.summary.scheduled },
                { key: "a", label: "实际出勤", children: detail.summary.attended },
                { key: "l", label: "迟到 / 早退", children: `${detail.summary.late} / ${detail.summary.early}` },
                { key: "m", label: "缺卡 / 缺勤", children: `${detail.summary.missing} / ${detail.summary.absent}` },
                { key: "v", label: "请假天数", children: detail.summary.leaveDays },
                { key: "o", label: "加班天数", children: detail.summary.overtimeDays },
              ]}
            />
            <SimpleList
              items={detail.days.filter((d) => d.state !== "UNSCHEDULED" || d.label !== "没排班")}
              rowKey={(d) => d.date}
              render={(d) => (
                <Space wrap>
                  <Typography.Text style={{ width: 90, display: "inline-block" }}>{dayLabel(d.date)}</Typography.Text>
                  <Typography.Text type={d.absent ? "danger" : d.late || d.early || d.missing ? "warning" : undefined}>{d.label}</Typography.Text>
                </Space>
              )}
            />
            {detail.manual.length ? (
              <Card size="small" title="补录记录">
                <SimpleList items={detail.manual} rowKey={(_, i) => i} render={(p) => `${p.date} ${PUNCH_LABELS[p.kind]} ${p.time}，${p.by}补录：${p.note ?? ""}`} />
              </Card>
            ) : null}
          </Space>
        ) : null}
      </Drawer>

      <Modal
        title="补卡"
        open={manualOpen}
        confirmLoading={pending}
        onCancel={() => setManualOpen(false)}
        onOk={() => {
          if (!manual.userId) return void message.error("选一下员工");
          act(() => manualPunchAction({ userId: manual.userId!, date: manual.date, kind: manual.kind, time: manual.time, note: manual.note }), () => setManualOpen(false));
        }}
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Typography.Paragraph type="secondary">员工漏打卡时补录，要写原因，会记到操作日志。不能给自己补，只能补上个月 1 号以后、已经过去的时间。</Typography.Paragraph>
          <Select showSearch={{ optionFilterProp: "label" }} placeholder="员工" style={{ width: "100%" }} value={manual.userId} options={targets.map((t) => ({ value: t.id, label: t.label }))} onChange={(v) => setManual({ ...manual, userId: v })} />
          <Space wrap>
            <DatePicker allowClear={false} value={dayjs(manual.date)} disabledDate={(d) => d.format("YYYY-MM-DD") > today.date} onChange={(d) => d && setManual({ ...manual, date: d.format("YYYY-MM-DD") })} />
            <Segmented<PunchKindKey> value={manual.kind} options={[{ value: "IN", label: "上班卡" }, { value: "OUT", label: "下班卡" }]} onChange={(v) => setManual({ ...manual, kind: v })} />
            <Input style={{ width: 100 }} value={manual.time} placeholder="09:00" maxLength={5} onChange={(e) => setManual({ ...manual, time: e.target.value })} />
          </Space>
          <Input placeholder="补卡原因（必填）" maxLength={100} value={manual.note} onChange={(e) => setManual({ ...manual, note: e.target.value })} />
        </Space>
      </Modal>
    </Space>
  );
}
