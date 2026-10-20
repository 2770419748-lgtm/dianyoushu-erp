"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Descriptions, Input, List, Modal, Space, Tag, Typography } from "antd";
import { APPROVAL_ACTION_LABELS, APPROVAL_RULE_LABELS, APPROVAL_STATUS_COLORS, APPROVAL_STATUS_LABELS, APPROVER_ROLE_LABELS, type ApprovalRuleKindKey } from "@/lib/approval";
import { formatDateTime, formatFen } from "@/lib/format";
import type { ApprovalDetail } from "@/server/approval/approval-service";
import { approveAction, cancelApprovalAction, rejectAction, type ApprovalActionResult } from "../actions";

export function ApprovalDetailView({ detail }: { detail: ApprovalDetail }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [modal, setModal] = useState<"approve" | "reject" | null>(null);
  const [note, setNote] = useState("");

  function act(fn: () => Promise<ApprovalActionResult>) {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) return void message.error(result.error);
      message.success(result.message ?? "已完成", 5);
      setModal(null);
      router.refresh();
    });
  }

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title={
          <Space wrap>
            {`${APPROVAL_ACTION_LABELS[detail.action]}审批 ${detail.requestNo}`}
            <Tag color={APPROVAL_STATUS_COLORS[detail.status]}>{APPROVAL_STATUS_LABELS[detail.status]}</Tag>
          </Space>
        }
        extra={
          <Space wrap>
            {detail.can.decide ? (
              <>
                <Button type="primary" onClick={() => { setNote(""); setModal("approve"); }}>
                  通过
                </Button>
                <Button danger onClick={() => { setNote(""); setModal("reject"); }}>
                  驳回
                </Button>
              </>
            ) : null}
            {detail.can.cancel ? (
              <Button loading={pending} onClick={() => act(() => cancelApprovalAction(detail.id))}>
                撤回
              </Button>
            ) : null}
            <Link href="/approvals">
              <Button>返回列表</Button>
            </Link>
          </Space>
        }
      >
        {detail.status === "EXECUTED" ? (
          <Alert type="success" showIcon style={{ marginBottom: 12 }} title={`已通过，系统已经做掉了${detail.resultNo ? `：${detail.resultNo}` : ""}`} action={detail.resultHref ? <Link href={detail.resultHref}>去看</Link> : undefined} />
        ) : null}
        {detail.status === "FAILED" ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} title={`批了，但这件事现在做不成：${detail.error ?? ""}`} description="情况变了（机器卖了、库存不够、当天已日结等），发起人按现在的情况重新做一遍；还要批会再生成一张审批单。" /> : null}
        {detail.status === "REJECTED" ? <Alert type="error" showIcon style={{ marginBottom: 12 }} title={`已驳回：${detail.decisionNote ?? ""}`} /> : null}
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2, md: 3 }}
          items={[
            { key: "summary", label: "摘要", children: detail.summary, span: "filled" as const },
            { key: "store", label: "门店", children: `${detail.store.code} ${detail.store.name}` },
            { key: "requester", label: "发起", children: `${detail.requestedBy.name}，${formatDateTime(detail.createdAt)}` },
            { key: "approver", label: "谁批", children: APPROVER_ROLE_LABELS[detail.approverRole as "STORE_MANAGER" | "HQ"] },
            { key: "amount", label: "关键金额", children: `${formatFen(detail.amountFen)} 元` },
            ...(detail.note ? [{ key: "note", label: "发起人说明", children: detail.note }] : []),
            ...(detail.decidedBy ? [{ key: "decided", label: "处理", children: `${detail.decidedBy.name}，${detail.decidedAt ? formatDateTime(detail.decidedAt) : ""}${detail.decisionNote && detail.status !== "REJECTED" ? `，${detail.decisionNote}` : ""}` }] : []),
          ]}
        />
      </Card>
      <Card title="为什么要批" size="small">
        <List
          size="small"
          dataSource={detail.reasons}
          renderItem={(r) => (
            <List.Item>
              <Space>
                <Tag>{APPROVAL_RULE_LABELS[r.kind as ApprovalRuleKindKey] ?? r.kind}</Tag>
                {r.text}
              </Space>
            </List.Item>
          )}
        />
      </Card>
      {detail.details.length > 0 ? (
        <Card title="明细" size="small">
          <List size="small" dataSource={detail.details} renderItem={(d) => <List.Item>{d}</List.Item>} />
        </Card>
      ) : null}
      <Modal title={modal === "approve" ? "通过" : "驳回"} open={modal !== null} confirmLoading={pending} onCancel={() => setModal(null)} onOk={() => act(() => (modal === "approve" ? approveAction(detail.id, note) : rejectAction(detail.id, note)))} destroyOnHidden>
        <Typography.Paragraph type="secondary">{modal === "approve" ? "通过后系统马上按现在的数据把这件事做掉（比如开单、退款），做不成会写明原因。" : "写一下驳回原因，发起人能看到。"}</Typography.Paragraph>
        <Input placeholder={modal === "approve" ? "说明（可不填）" : "驳回原因"} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </Modal>
    </Space>
  );
}
