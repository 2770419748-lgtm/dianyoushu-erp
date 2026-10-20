"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Modal, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { formatDateTime } from "@/lib/format";
import type { TransferPage } from "@/server/wecom/transfer-service";
import { assignResignedAction, processTransfersAction } from "./actions";

// 客户继承：上面是统计和“查进度”，中间是还没安排接手人的离职员工，下面是最近的继承记录。

type Row = TransferPage["rows"][number];
type PendingUser = TransferPage["pendingUsers"][number];

const STATUS: Record<Row["status"], { label: string; color: string }> = {
  WAITING_DELETE: { label: "等删除成员", color: "default" },
  SUBMITTED: { label: "等客户接替", color: "blue" },
  DONE: { label: "接替完毕", color: "green" },
  REFUSED: { label: "客户拒绝", color: "orange" },
  FAILED: { label: "没成", color: "red" },
};

export function TransfersView({ mode, data }: { mode: "real" | "simulated"; data: TransferPage }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [assign, setAssign] = useState<PendingUser | null>(null);
  const [toUserId, setToUserId] = useState<number | undefined>(undefined);

  function act(fn: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>, done?: () => void) {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        message.error(result.error);
        return;
      }
      message.success(result.message);
      done?.();
      router.refresh();
    });
  }

  const columns: TableColumnsType<Row> = [
    { title: "发起时间", dataIndex: "createdAt", render: (v: Date) => formatDateTime(v) },
    { title: "种类", dataIndex: "kind", render: (k: Row["kind"]) => (k === "ON_JOB" ? "在职转接" : "离职继承") },
    { title: "客户", render: (_, r) => (r.customer ? <Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link> : `微信用户${r.externalUserid.slice(-4).toUpperCase()}（没绑定档案）`) },
    { title: "从", dataIndex: "from" },
    { title: "交给", dataIndex: "to" },
    { title: "进度", render: (_, r) => <Tag color={STATUS[r.status].color}>{STATUS[r.status].label}</Tag> },
    { title: "结果", render: (_, r) => r.error ?? (r.finishedAt ? formatDateTime(r.finishedAt) : r.submittedAt ? `${formatDateTime(r.submittedAt)} 提交` : "-") },
  ];

  const c = data.counts;
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        title="客户继承"
        description={
          mode === "simulated"
            ? "模拟模式：企业微信那边当作成员已经删了、24 小时已经过了，点“查进度”马上出结果（每 8 个客户里大约 1 个拒绝）。真对接时每日任务查一次。"
            : "在职转接：客户 24 小时内可以拒绝，同一个客户 90 天内最多转 2 次。离职继承：先在企业微信后台删掉这个人才能提交。结果每天查一次，也可以点“查进度”。"
        }
      />
      <Card
        title="进度"
        extra={
          <Button type="primary" loading={pending} onClick={() => act(processTransfersAction)}>
            查进度
          </Button>
        }
      >
        <Space size="large" wrap>
          <Statistic title="等删除成员" value={c.WAITING_DELETE ?? 0} />
          <Statistic title="等客户接替" value={c.SUBMITTED ?? 0} />
          <Statistic title="接替完毕" value={c.DONE ?? 0} />
          <Statistic title="客户拒绝" value={c.REFUSED ?? 0} />
          <Statistic title="没成" value={c.FAILED ?? 0} />
        </Space>
      </Card>
      {data.pendingUsers.length > 0 ? (
        <Card title="离职员工还有客户没安排接手人">
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={data.pendingUsers}
            columns={[
              { title: "员工", dataIndex: "name" },
              { title: "门店", dataIndex: "store", render: (v: string | null) => v ?? "-" },
              { title: "跟进中的客户", dataIndex: "follows" },
              {
                title: "操作",
                render: (_, u) => (
                  <Button
                    size="small"
                    onClick={() => {
                      setToUserId(undefined);
                      setAssign(u);
                    }}
                  >
                    安排接手人
                  </Button>
                ),
              },
            ]}
          />
        </Card>
      ) : null}
      <Card title="最近的继承（最多 100 条）">
        <Typography.Paragraph type="secondary">在职转接从客户详情的企业微信区发起；离职继承在组织管理停用员工时，或者上面“安排接手人”发起。</Typography.Paragraph>
        <Table rowKey="id" size="small" columns={columns} dataSource={data.rows} pagination={false} scroll={{ x: true }} locale={{ emptyText: "还没有客户继承" }} />
      </Card>
      <Modal
        title={`安排接手人：${assign?.name ?? ""}`}
        open={assign !== null}
        okText="生成离职继承"
        okButtonProps={{ disabled: !toUserId }}
        confirmLoading={pending}
        onCancel={() => setAssign(null)}
        onOk={() => assign && toUserId && act(() => assignResignedAction(assign.id, toUserId), () => setAssign(null))}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">{assign?.follows ?? 0} 个跟进中的客户都交给这个人。企业微信后台删掉{assign?.name}之后提交，客户 24 小时内可以拒绝。</Typography.Paragraph>
        <Select style={{ width: "100%" }} placeholder="选接手人" value={toUserId} onChange={setToUserId} options={data.targets.map((t) => ({ value: t.id, label: t.label }))} showSearch optionFilterProp="label" />
      </Modal>
    </Space>
  );
}
