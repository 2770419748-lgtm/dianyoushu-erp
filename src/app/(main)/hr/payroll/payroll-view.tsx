"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, DatePicker, Descriptions, Input, InputNumber, Modal, Popconfirm, Space, Statistic, Switch, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import { formatDateTime, formatFen, yuanToFen } from "@/lib/format";
import { PAYROLL_STATUS_COLORS, PAYROLL_STATUS_LABELS, rateText } from "@/lib/payroll";
import type { PayrollPage, PlanRow } from "@/server/hr/payroll-service";
import { adjustAction, generatePayrollAction, publishPayrollAction, savePlanAction, voidPayrollAction, type PayrollActionResult } from "./actions";

type Manage = Extract<PayrollPage, { manage: true }>;
type Mine = Extract<PayrollPage, { manage: false }>;
type Slip = NonNullable<Manage["run"]>["slips"][number];

const yuan = (fen: number) => formatFen(fen);

export function PayrollView({ data }: { data: PayrollPage }) {
  return data.manage ? <ManageView data={data} /> : <MineView data={data} />;
}

function useAct() {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const act = (fn: () => Promise<PayrollActionResult>, after?: () => void) =>
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) return void message.error(r.error);
      message.success(r.message, 5);
      after?.();
      router.refresh();
    });
  return { pending, act, router, message };
}

function ManageView({ data }: { data: Manage }) {
  const { pending, act, router, message } = useAct();
  const run = data.run;
  const [adjusting, setAdjusting] = useState<Slip | null>(null);
  const [adj, setAdj] = useState<{ amount: number | null; note: string }>({ amount: null, note: "" });
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [plan, setPlan] = useState<(Partial<PlanRow> & { rate?: number | null; perDevice?: number | null; perService?: number | null }) | null>(null);

  const columns: TableColumnsType<Slip> = [
    { title: "员工", fixed: "left", render: (_, s) => <Space size={4}>{s.user.name}{s.user.isActive ? null : <Tag>已停用</Tag>}</Space> },
    { title: "门店", render: (_, s) => (s.store ? s.store.name : "总部") },
    { title: "提成方案", dataIndex: "planName", render: (v: string | null) => v ?? "-" },
    { title: "基本工资", align: "right", render: (_, s) => yuan(s.baseSalaryFen) },
    { title: "在职天数", align: "right", render: (_, s) => (s.employedDays === s.daysInMonth ? s.employedDays : <Typography.Text type="warning">{s.employedDays}</Typography.Text>) },
    { title: "折算后", align: "right", render: (_, s) => yuan(s.baseFen) },
    { title: "缺勤天数", align: "right", render: (_, s) => (s.absentDays ? <Typography.Text type="danger">{s.absentDays}</Typography.Text> : 0) },
    { title: "缺勤扣款", align: "right", render: (_, s) => (s.absenceDeductionFen ? `−${yuan(s.absenceDeductionFen)}` : "0.00") },
    { title: "销售额", align: "right", render: (_, s) => yuan(s.salesFen) },
    { title: "主机 / 服务", align: "right", render: (_, s) => `${s.deviceQty} 台 / ${s.serviceQty} 份` },
    { title: "提成", align: "right", render: (_, s) => yuan(s.commissionFen) },
    {
      title: "奖惩",
      align: "right",
      render: (_, s) => (
        <Space orientation="vertical" size={0} style={{ alignItems: "flex-end" }}>
          {yuan(s.adjustmentFen)}
          {s.adjustmentNote ? <Typography.Text type="secondary">{s.adjustmentNote}</Typography.Text> : null}
        </Space>
      ),
    },
    { title: "应发", align: "right", render: (_, s) => <Typography.Text strong>{yuan(s.grossFen)}</Typography.Text> },
    ...(run?.status === "DRAFT"
      ? [{ title: "", fixed: "right" as const, render: (_: unknown, s: Slip) => <a onClick={() => { setAdj({ amount: s.adjustmentFen / 100, note: s.adjustmentNote ?? "" }); setAdjusting(s); }}>改奖惩</a> }]
      : []),
  ];

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="工资条"
        extra={
          <DatePicker picker="month" allowClear={false} value={dayjs(`${data.month}-01`)} disabledDate={(d) => d.format("YYYY-MM") > data.thisMonth} onChange={(d) => d && router.push(`/hr/payroll?month=${d.format("YYYY-MM")}`)} />
        }
      >
        <Typography.Paragraph type="secondary">
          应发 = 基本工资（入职、离职当月按在职天数折算）+ 提成 − 缺勤扣款（缺勤一天扣 基本工资 ÷ 当月 {data.daysInMonth} 天）+ 其他奖惩。提成按员工档案里选的方案：销售额（按开单人，扣掉退货）× 比例 + 每台主机 + 每份碎屏险延保。社保、个税财务另算。草稿能改奖惩、重算；发布后员工能看自己的，数字锁定，要改只能整月作废重算。
        </Typography.Paragraph>
        {run ? (
          <Space wrap size="large" style={{ marginBottom: 12 }}>
            <Statistic title="状态" valueRender={() => <Tag color={PAYROLL_STATUS_COLORS[run.status]}>{PAYROLL_STATUS_LABELS[run.status]}</Tag>} />
            <Statistic title="人数" value={run.slipCount} />
            <Statistic title="应发合计（元）" value={yuan(run.grossFen)} />
            <Statistic title={run.publishedAt ? "发布时间" : "生成时间"} value={formatDateTime(run.publishedAt ?? run.generatedAt)} />
          </Space>
        ) : (
          <Alert type="info" showIcon style={{ marginBottom: 12 }} title={`${data.month} 还没生成工资条`} />
        )}
        <Space wrap style={{ marginBottom: 12 }}>
          {!run || run.status === "DRAFT" ? (
            <Button type={run ? "default" : "primary"} loading={pending} onClick={() => act(() => generatePayrollAction(data.month))}>
              {run ? "重新算（奖惩保留）" : "生成工资条"}
            </Button>
          ) : null}
          {run?.status === "DRAFT" ? (
            <Popconfirm title={`发布 ${data.month} 的工资条？发布后数字锁定，员工能看自己的。`} onConfirm={() => act(() => publishPayrollAction(run.id))}>
              <Button type="primary" loading={pending}>
                发布
              </Button>
            </Popconfirm>
          ) : null}
          {run ? (
            <Button danger onClick={() => { setVoidReason(""); setVoiding(true); }}>
              整月作废
            </Button>
          ) : null}
        </Space>
        {data.voided.length ? (
          <Typography.Paragraph type="secondary">
            这个月作废过 {data.voided.length} 次：{data.voided.map((v) => `${v.voidedAt ? formatDateTime(v.voidedAt) : ""} ${v.voidReason ?? ""}`).join("；")}
          </Typography.Paragraph>
        ) : null}
        {run ? <Table rowKey="id" size="small" columns={columns} dataSource={run.slips} pagination={{ pageSize: 50, hideOnSinglePage: true }} scroll={{ x: 1500 }} /> : null}
      </Card>

      <Card
        title="提成方案"
        extra={
          <Button onClick={() => setPlan({ name: "", rate: 1, perDevice: 0, perService: 0, isActive: true, note: "" })}>
            新增方案
          </Button>
        }
      >
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={data.plans}
          columns={[
            { title: "方案", render: (_, p) => <Space size={4}>{p.name}{p.isActive ? null : <Tag>停用</Tag>}</Space> },
            { title: "销售额提成", render: (_, p) => rateText(p.salesRateBp) },
            { title: "每台主机（元）", align: "right", render: (_, p) => yuan(p.perDeviceFen) },
            { title: "每份碎屏险延保（元）", align: "right", render: (_, p) => yuan(p.perServiceFen) },
            { title: "用的人", align: "right", dataIndex: "people" },
            { title: "备注", dataIndex: "note", render: (v: string | null) => v ?? "-" },
            { title: "", render: (_, p) => <a onClick={() => setPlan({ ...p, rate: p.salesRateBp / 100, perDevice: p.perDeviceFen / 100, perService: p.perServiceFen / 100 })}>编辑</a> },
          ]}
        />
        <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
          在“员工档案”里给每个人选方案；没选方案的没有提成。改了方案，下次生成（或重新算）工资条时按新的算，已发布的不变。
        </Typography.Paragraph>
      </Card>

      <Modal
        title={adjusting ? `改奖惩：${adjusting.user.name}` : ""}
        open={adjusting !== null}
        confirmLoading={pending}
        onCancel={() => setAdjusting(null)}
        onOk={() => adjusting && act(() => adjustAction(adjusting.id, adj.amount === null ? 0 : yuanToFen(adj.amount), adj.note), () => setAdjusting(null))}
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <InputNumber style={{ width: 200 }} precision={2} addonAfter="元" placeholder="奖为正、罚为负" value={adj.amount} onChange={(v) => setAdj({ ...adj, amount: v })} />
          <Input placeholder="原因（不为 0 时必填，员工能看到）" maxLength={100} value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} />
        </Space>
      </Modal>

      <Modal
        title={`整月作废 ${data.month} 的工资`}
        open={voiding}
        confirmLoading={pending}
        okText="作废"
        okButtonProps={{ danger: true }}
        onCancel={() => setVoiding(false)}
        onOk={() => run && act(() => voidPayrollAction(run.id, voidReason), () => setVoiding(false))}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">作废后员工看不到这个月的工资条了，可以重新生成。作废记录和原因会留着。</Typography.Paragraph>
        <Input placeholder="为什么作废（必填）" maxLength={100} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
      </Modal>

      <Modal
        title={plan?.id ? `编辑方案：${plan.name}` : "新增提成方案"}
        open={plan !== null}
        confirmLoading={pending}
        onCancel={() => setPlan(null)}
        onOk={() => {
          if (!plan) return;
          if (plan.rate === null || plan.rate === undefined) return void message.error("填一下销售额提成比例");
          act(
            () =>
              savePlanAction({
                id: plan.id,
                name: plan.name ?? "",
                salesRateBp: Math.round((plan.rate ?? 0) * 100),
                perDeviceFen: yuanToFen(plan.perDevice ?? 0),
                perServiceFen: yuanToFen(plan.perService ?? 0),
                isActive: plan.isActive !== false,
                note: plan.note ?? "",
              }),
            () => setPlan(null),
          );
        }}
        destroyOnHidden
      >
        {plan ? (
          <Space orientation="vertical" style={{ width: "100%" }}>
            <Input placeholder="方案名（比如“店员方案”）" maxLength={30} value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} />
            <InputNumber style={{ width: 240 }} min={0} max={100} precision={2} addonBefore="销售额提成" addonAfter="%" value={plan.rate} onChange={(v) => setPlan({ ...plan, rate: v })} />
            <InputNumber style={{ width: 240 }} min={0} precision={2} addonBefore="每台主机" addonAfter="元" value={plan.perDevice} onChange={(v) => setPlan({ ...plan, perDevice: v })} />
            <InputNumber style={{ width: 240 }} min={0} precision={2} addonBefore="每份碎屏险延保" addonAfter="元" value={plan.perService} onChange={(v) => setPlan({ ...plan, perService: v })} />
            <Space>
              <Switch checked={plan.isActive !== false} onChange={(v) => setPlan({ ...plan, isActive: v })} />
              <Typography.Text>{plan.isActive !== false ? "在用" : "停用（员工档案里不能再选）"}</Typography.Text>
            </Space>
            <Input placeholder="备注（可不填）" maxLength={100} value={plan.note ?? ""} onChange={(e) => setPlan({ ...plan, note: e.target.value })} />
          </Space>
        ) : null}
      </Modal>
    </Space>
  );
}

function MineView({ data }: { data: Mine }) {
  return (
    <Card title="我的工资条">
      <Typography.Paragraph type="secondary">只有你自己和总部能看。应发 = 基本工资（入职、离职当月按在职天数折算）+ 提成 − 缺勤扣款 + 其他奖惩；社保、个税由财务另算。</Typography.Paragraph>
      {data.mine.length === 0 ? <Alert type="info" showIcon title="还没有发布的工资条" /> : null}
      <Space orientation="vertical" style={{ width: "100%" }}>
        {data.mine.map((s) => (
          <Card key={s.id} size="small" type={s.month === data.month ? "inner" : undefined} title={`${s.month} 应发 ${yuan(s.grossFen)} 元`}>
            <Descriptions
              size="small"
              column={{ xs: 1, sm: 2, md: 3 }}
              items={[
                { key: "base", label: "基本工资", children: `${yuan(s.baseSalaryFen)} 元${s.employedDays < s.daysInMonth ? `，在职 ${s.employedDays}/${s.daysInMonth} 天折算 ${yuan(s.baseFen)} 元` : ""}` },
                { key: "absent", label: "缺勤", children: s.absentDays ? `${s.absentDays} 天，扣 ${yuan(s.absenceDeductionFen)} 元` : "没有" },
                { key: "sales", label: "销售额", children: `${yuan(s.salesFen)} 元，主机 ${s.deviceQty} 台，碎屏险延保 ${s.serviceQty} 份` },
                { key: "commission", label: `提成${s.planName ? `（${s.planName}）` : ""}`, children: `${yuan(s.commissionFen)} 元（销售额 ${yuan(s.salesCommissionFen)} + 主机 ${yuan(s.deviceCommissionFen)} + 服务 ${yuan(s.serviceCommissionFen)}）` },
                { key: "adj", label: "其他奖惩", children: s.adjustmentFen ? `${yuan(s.adjustmentFen)} 元，${s.adjustmentNote ?? ""}` : "没有" },
                { key: "gross", label: "应发", children: <Typography.Text strong>{yuan(s.grossFen)} 元</Typography.Text> },
              ]}
            />
          </Card>
        ))}
      </Space>
    </Card>
  );
}
