"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Segmented, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import type { ApprovalStatus } from "@/generated/prisma/enums";
import { APPROVAL_ACTION_LABELS, APPROVAL_STATUS_COLORS, APPROVAL_STATUS_LABELS, APPROVER_ROLE_LABELS } from "@/lib/approval";
import { formatDateTime, formatFen } from "@/lib/format";
import type { ApprovalRow, ApprovalView, listApprovals } from "@/server/approval/approval-service";

type Data = Awaited<ReturnType<typeof listApprovals>>;

export function ApprovalsView({ data, status, canDecide }: { data: Data; status?: ApprovalStatus; canDecide: boolean }) {
  const router = useRouter();

  function navigate(next: { view?: ApprovalView; status?: ApprovalStatus | null; page?: number }) {
    const sp = new URLSearchParams();
    sp.set("view", next.view ?? data.view);
    const s = next.status === undefined ? status : next.status;
    if (s) sp.set("status", s);
    if (next.page && next.page > 1) sp.set("page", String(next.page));
    router.push(`/approvals?${sp}`);
  }

  const columns: TableColumnsType<ApprovalRow> = [
    { title: "审批单号", dataIndex: "requestNo", render: (v: string, r) => <Link href={`/approvals/${r.id}`}>{v}</Link> },
    { title: "发起时间", dataIndex: "createdAt", render: (v: Date) => formatDateTime(v) },
    { title: "事项", dataIndex: "action", render: (v: ApprovalRow["action"]) => APPROVAL_ACTION_LABELS[v] },
    { title: "门店", render: (_, r) => `${r.store.code} ${r.store.name}` },
    { title: "发起人", render: (_, r) => r.requestedBy.name },
    { title: "摘要", dataIndex: "summary", render: (v: string) => <Typography.Text ellipsis={{ tooltip: v }} style={{ maxWidth: 360 }}>{v}</Typography.Text> },
    { title: "关键金额（元）", dataIndex: "amountFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "谁批", dataIndex: "approverRole", render: (v: "STORE_MANAGER" | "HQ") => APPROVER_ROLE_LABELS[v] },
    {
      title: "状态",
      render: (_, r) => (
        <Space orientation="vertical" size={0}>
          <Tag color={APPROVAL_STATUS_COLORS[r.status]}>{APPROVAL_STATUS_LABELS[r.status]}</Tag>
          {r.decidedBy ? <Typography.Text type="secondary">{r.decidedBy.name}</Typography.Text> : null}
          {r.resultNo ? <Typography.Text type="secondary">{r.resultNo}</Typography.Text> : null}
        </Space>
      ),
    },
    { title: "", render: (_, r) => <Link href={`/approvals/${r.id}`}>{r.status === "PENDING" && data.view === "todo" ? <Button size="small" type="primary">去审批</Button> : "详情"}</Link> },
  ];

  const views: { value: ApprovalView; label: React.ReactNode }[] = [
    ...(canDecide ? [{ value: "todo" as const, label: <Badge count={data.todoCount} size="small" offset={[8, -2]}>待我审批</Badge> }] : []),
    { value: "mine", label: "我发起的" },
    { value: "all", label: "全部" },
  ];

  return (
    <Card
      title="审批"
      extra={
        data.canManageRules ? (
          <Link href="/approvals/rules">
            <Button>审批规则</Button>
          </Link>
        ) : null
      }
    >
      <Typography.Paragraph type="secondary">
        开单让利太多、低于成本卖、大额退款、作废销售单、大额调拨、盘亏多，按总部配的审批规则先提交审批（规则默认都关着）；审批人通过后，系统按当时的数据把这件事做掉，做不成的（比如机器已经卖了）会写明原因。
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented<ApprovalView> value={data.view} options={views} onChange={(v) => navigate({ view: v, page: 1 })} />
        <Select allowClear placeholder="状态" style={{ width: 130 }} value={status} options={(Object.keys(APPROVAL_STATUS_LABELS) as ApprovalStatus[]).map((s) => ({ value: s, label: APPROVAL_STATUS_LABELS[s] }))} onChange={(v) => navigate({ status: v ?? null, page: 1 })} />
      </Space>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={data.rows}
        scroll={{ x: 1200 }}
        locale={{ emptyText: data.view === "todo" ? "没有等你审批的" : "没有审批单" }}
        pagination={{ current: data.page, pageSize: data.pageSize, total: data.total, showSizeChanger: false, onChange: (p) => navigate({ page: p }) }}
      />
    </Card>
  );
}
