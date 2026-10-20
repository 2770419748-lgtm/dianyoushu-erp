"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Card, Checkbox, Input, Modal, Segmented, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { REMINDER_STAGE_LABELS, REMINDER_T7_MAX_DAYS, type ReminderStageKey } from "@/lib/entitlement";
import { formatDate, formatDateTime } from "@/lib/format";
import type { ExpiringEntitlementRow, listExpiringEntitlements } from "@/server/entitlement/entitlement-service";
import { markContactedAction, runReminderScanAction } from "./actions";

type Data = Awaited<ReturnType<typeof listExpiringEntitlements>>;

export function EntitlementsView({ data, stage, stores, storeId, mine }: { data: Data; stage: ReminderStageKey; stores: { id: number; label: string }[]; storeId?: number; mine: boolean }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [contactModal, setContactModal] = useState<{ open: boolean; row?: ExpiringEntitlementRow }>({ open: false });
  const [note, setNote] = useState("");

  function navigate(next: { stage?: ReminderStageKey; storeId?: number | null; mine?: boolean; page?: number }) {
    const sp = new URLSearchParams();
    const nextStage = next.stage ?? stage;
    if (nextStage !== "T7") sp.set("stage", nextStage);
    const nextStore = next.storeId === undefined ? storeId : next.storeId;
    if (nextStore) sp.set("storeId", String(nextStore));
    if (next.mine ?? mine) sp.set("mine", "1");
    if (next.page && next.page > 1) sp.set("page", String(next.page));
    router.push(`/entitlements${sp.size ? `?${sp}` : ""}`);
  }

  function scan() {
    startTransition(async () => {
      const result = await runReminderScanAction();
      if (result.ok) message.success(result.message ?? "已生成");
      else message.error(result.error);
    });
  }

  function saveContacted() {
    const reminder = contactModal.row?.reminder;
    if (!reminder) return;
    startTransition(async () => {
      const result = await markContactedAction(reminder.id, note);
      if (result.ok) {
        message.success("已记下");
        setContactModal({ open: false });
      } else {
        message.error(result.error);
      }
    });
  }

  const columns: TableColumnsType<ExpiringEntitlementRow> = [
    {
      title: "客户",
      render: (_, r) => (
        <Space orientation="vertical" size={0}>
          {data.canOpenCustomer ? <Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link> : r.customer.name}
          <Typography.Text type="secondary">{r.customer.phoneMasked}</Typography.Text>
        </Space>
      ),
    },
    { title: "服务", render: (_, r) => r.sku.name },
    {
      title: "保的机器",
      render: (_, r) =>
        r.device ? (
          <Space size={4}>
            <Link href={`/stock/devices/${r.device.code}`}>{r.device.code}</Link>
            {r.deviceReturnedAt ? <Tag>机器已退回</Tag> : null}
          </Space>
        ) : (
          "-"
        ),
    },
    { title: "门店", render: (_, r) => `${r.store.code} ${r.store.name}` },
    { title: "开单人", render: (_, r) => r.salesOrder.salesperson.name },
    { title: "到期日", dataIndex: "expiresOn", render: (v: Date) => formatDate(v) },
    {
      title: "剩余",
      align: "right",
      render: (_, r) => <Typography.Text type={r.daysLeft <= REMINDER_T7_MAX_DAYS ? "danger" : "warning"}>{r.daysLeft === 0 ? "今天到期" : `${r.daysLeft} 天`}</Typography.Text>,
    },
    {
      title: "本档提醒",
      render: (_, r) =>
        !r.reminder ? (
          <Tag>未生成</Tag>
        ) : r.reminder.contactedAt ? (
          <Space orientation="vertical" size={0}>
            <Tag color="green">已联系 · {r.reminder.contactedBy?.name ?? ""} · {formatDate(r.reminder.contactedAt)}</Tag>
            {r.reminder.note ? <Typography.Text type="secondary">{r.reminder.note}</Typography.Text> : null}
          </Space>
        ) : (
          <Tag color="orange">待联系 · {formatDateTime(r.reminder.createdAt)} 生成</Tag>
        ),
    },
    {
      title: "操作",
      render: (_, r) =>
        data.canFollowUp && r.reminder && !r.reminder.contactedAt ? (
          <Button
            size="small"
            onClick={() => {
              setNote("");
              setContactModal({ open: true, row: r });
            }}
          >
            已联系
          </Button>
        ) : null,
    },
  ];

  return (
    <Card
      title={`到期名单（${data.total}）`}
      extra={
        data.canScan ? (
          <Button loading={pending} onClick={scan}>
            生成提醒
          </Button>
        ) : null
      }
    >
      <Typography.Paragraph type="secondary">
        碎屏险、延保快到期的客户，分“剩 0～7 天”“剩 8～30 天”两档；每档对同一份服务只生成一次提醒：每日任务（pnpm daily，要在服务器上配成每天定时跑）会扫一遍，没配或想马上看就手动点“生成提醒”。联系过客户后点“已联系”记下结果。
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented<ReminderStageKey>
          value={stage}
          options={(["T7", "T30"] as const).map((s) => ({ value: s, label: REMINDER_STAGE_LABELS[s] }))}
          onChange={(value) => navigate({ stage: value, page: 1 })}
        />
        {stores.length > 1 ? (
          <Select
            allowClear
            placeholder="全部门店"
            style={{ width: 200 }}
            value={storeId}
            options={stores.map((s) => ({ value: s.id, label: s.label }))}
            onChange={(value) => navigate({ storeId: value ?? null, page: 1 })}
          />
        ) : null}
        {data.canFollowUp ? (
          <Checkbox checked={mine} onChange={(e) => navigate({ mine: e.target.checked, page: 1 })}>
            只看我开的单
          </Checkbox>
        ) : null}
      </Space>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={data.rows}
        scroll={{ x: true }}
        locale={{ emptyText: "这一档没有快到期的服务" }}
        pagination={{ current: data.page, pageSize: data.pageSize, total: data.total, showSizeChanger: false, onChange: (p) => navigate({ page: p }) }}
      />

      <Modal
        title={`记一下联系结果：${contactModal.row?.customer.name ?? ""}`}
        open={contactModal.open}
        confirmLoading={pending}
        okText="已联系"
        onOk={saveContacted}
        onCancel={() => setContactModal({ open: false })}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          {contactModal.row ? `${contactModal.row.sku.name}，${formatDate(contactModal.row.expiresOn)} 到期。` : ""}联系结果可以不填。
        </Typography.Paragraph>
        <Input.TextArea rows={2} maxLength={100} value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：已续保、客户说再考虑、电话没接通" />
      </Modal>
    </Card>
  );
}
