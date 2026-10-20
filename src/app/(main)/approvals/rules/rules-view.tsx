"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Card, Form, Input, InputNumber, Modal, Select, Switch, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { APPROVAL_RULE_HINTS, APPROVAL_RULE_LABELS, APPROVER_ROLE_LABELS, type ApprovalRuleKindKey, type ApproverRoleKey } from "@/lib/approval";
import { formatDateTime, formatFen, yuanToFen } from "@/lib/format";
import { saveRuleAction } from "../actions";

type Rule = { kind: ApprovalRuleKindKey; enabled: boolean; thresholdFen: number | null; thresholdBp: number | null; approverRole: ApproverRoleKey; note: string | null; updatedAt: Date | null; hqOnly: boolean };
type Values = { enabled: boolean; thresholdYuan?: number | null; thresholdPct?: number | null; approverRole: ApproverRoleKey; note?: string };

export function RulesView({ rules }: { rules: Rule[] }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<Rule | null>(null);
  const [form] = Form.useForm<Values>();

  function edit(rule: Rule) {
    form.setFieldsValue({ enabled: rule.enabled, thresholdYuan: rule.thresholdFen === null ? null : rule.thresholdFen / 100, thresholdPct: rule.thresholdBp === null ? null : rule.thresholdBp / 100, approverRole: rule.approverRole, note: rule.note ?? "" });
    setEditing(rule);
  }

  function save() {
    const rule = editing;
    if (!rule) return;
    form.validateFields().then((v) =>
      startTransition(async () => {
        const result = await saveRuleAction({
          kind: rule.kind,
          enabled: v.enabled,
          thresholdFen: v.thresholdYuan === null || v.thresholdYuan === undefined ? null : yuanToFen(v.thresholdYuan),
          thresholdBp: v.thresholdPct === null || v.thresholdPct === undefined ? null : Math.round(v.thresholdPct * 100),
          approverRole: v.approverRole,
          note: v.note,
        });
        if (!result.ok) return void message.error(result.error);
        message.success(result.message ?? "已保存");
        setEditing(null);
        router.refresh();
      }),
    );
  }

  const threshold = (r: Rule) => {
    if (r.kind === "SALE_BELOW_COST") return "-";
    const parts = [r.thresholdFen !== null ? `${formatFen(r.thresholdFen)} 元` : "", r.thresholdBp !== null ? `${r.thresholdBp / 100}%` : ""].filter(Boolean);
    return parts.length ? parts.join(" 或 ") : "未填";
  };

  const columns: TableColumnsType<Rule> = [
    { title: "场景", dataIndex: "kind", render: (v: ApprovalRuleKindKey) => APPROVAL_RULE_LABELS[v] },
    { title: "什么时候要批", dataIndex: "kind", render: (v: ApprovalRuleKindKey) => <Typography.Text type="secondary">{APPROVAL_RULE_HINTS[v]}</Typography.Text> },
    { title: "门槛", render: (_, r) => threshold(r) },
    { title: "谁批", dataIndex: "approverRole", render: (v: ApproverRoleKey) => APPROVER_ROLE_LABELS[v] },
    { title: "状态", dataIndex: "enabled", render: (v: boolean) => (v ? <Tag color="green">打开</Tag> : <Tag>关着</Tag>) },
    { title: "备注", dataIndex: "note", render: (v: string | null) => v ?? "" },
    { title: "改于", dataIndex: "updatedAt", render: (v: Date | null) => (v ? formatDateTime(v) : "") },
    { title: "操作", render: (_, r) => <Button size="small" onClick={() => edit(r)}>改</Button> },
  ];

  return (
    <Card
      title="审批规则"
      extra={
        <Link href="/approvals">
          <Button>返回审批</Button>
        </Link>
      }
    >
      <Typography.Paragraph type="secondary">
        默认全关，和以前一样不用审批（改价不设下限）。打开之后，触发了的操作先提交审批，批了系统再做。发起人的角色已经够得上审批人的不用批：店长自己做、规则写店长批，不用批；总部做的都不用批。
      </Typography.Paragraph>
      <Table rowKey="kind" size="small" columns={columns} dataSource={rules} pagination={false} scroll={{ x: 1000 }} />
      <Modal title={editing ? `审批规则：${APPROVAL_RULE_LABELS[editing.kind]}` : ""} open={!!editing} confirmLoading={pending} onOk={save} onCancel={() => setEditing(null)} destroyOnHidden>
        {editing ? <Typography.Paragraph type="secondary">{APPROVAL_RULE_HINTS[editing.kind]}</Typography.Paragraph> : null}
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="enabled" label="打开" valuePropName="checked">
            <Switch />
          </Form.Item>
          {editing && editing.kind !== "SALE_BELOW_COST" ? (
            <Form.Item name="thresholdYuan" label={editing.kind === "SALE_DISCOUNT" ? "让利金额门槛（元，可不填）" : "金额门槛（元）"} extra={editing.kind === "SALE_VOID" ? "填 0 就是作废都要批" : undefined}>
              <InputNumber min={0} precision={2} style={{ width: 180 }} />
            </Form.Item>
          ) : null}
          {editing?.kind === "SALE_DISCOUNT" ? (
            <Form.Item name="thresholdPct" label="让利比例门槛（%，可不填）" extra="让利占原价合计的比例；金额、比例都填的，达到任一个就要批">
              <InputNumber min={0} max={100} precision={2} style={{ width: 180 }} />
            </Form.Item>
          ) : null}
          <Form.Item name="approverRole" label="谁批" extra={editing?.hqOnly ? "这件事本来就是店长做的，只能总部批" : undefined}>
            <Select
              style={{ width: 180 }}
              disabled={editing?.hqOnly}
              options={[
                { value: "STORE_MANAGER", label: "店长（本店）或总部" },
                { value: "HQ", label: "总部" },
              ]}
            />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
