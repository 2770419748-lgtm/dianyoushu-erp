"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Input, Modal, Select, Typography } from "antd";
import { transferFollowAction, unbindWecomAction } from "./wecom-actions";

// 客户详情企业微信区的“转接跟进人”（口径第 12 节第三步）：选接手人，马上提交企业微信的在职转接。
export function WecomTransferButton({ followId, staff, targets }: { followId: number; staff: string; targets: { id: number; label: string }[] }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [toUserId, setToUserId] = useState<number | undefined>(undefined);
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!toUserId) return;
    startTransition(async () => {
      const result = await transferFollowAction(followId, toUserId);
      if (!result.ok) {
        message.error(result.error);
        return;
      }
      message.success(`已提交转接给${result.to}，客户 24 小时内可以拒绝，结果在“客户继承”里看`);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        转接跟进人
      </Button>
      <Modal title={`转接 ${staff} 的这个客户`} open={open} okText="提交转接" okButtonProps={{ disabled: !toUserId }} confirmLoading={pending} onOk={submit} onCancel={() => setOpen(false)} destroyOnHidden>
        <Typography.Paragraph type="secondary">
          提交后企业微信会通知客户，客户 24 小时内可以拒绝，过了自动接替；同一个客户 90 天内最多转 2 次。转好后客户档案的绑定不变，跟进人换成接手人。
        </Typography.Paragraph>
        <Select style={{ width: "100%" }} placeholder="选接手人" value={toUserId} onChange={setToUserId} options={targets.map((t) => ({ value: t.id, label: t.label }))} showSearch optionFilterProp="label" />
      </Modal>
    </>
  );
}

// 解绑微信（认领绑错了、客户报错了号，2026-10-21 复查后补）：店长、总部，写原因、记日志
export function WecomUnbindButton({ customerId }: { customerId: number }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  function submit() {
    startTransition(async () => {
      const result = await unbindWecomAction(customerId, reason);
      if (!result.ok) {
        message.error(result.error);
        return;
      }
      message.success("解绑了，客户本人的微信可以重新扫码或认领");
      setOpen(false);
      router.refresh();
    });
  }
  return (
    <>
      <Button size="small" danger onClick={() => setOpen(true)}>
        解绑微信
      </Button>
      <Modal title="解绑这个客户的微信" open={open} okText="解绑" okButtonProps={{ danger: true, disabled: !reason.trim() }} confirmLoading={pending} onOk={submit} onCancel={() => setOpen(false)} destroyOnHidden>
        <Typography.Paragraph type="secondary">绑错了才解绑：解绑后这个微信不再算这个客户，客服问“我的保障”会转人工；客户本人的微信可以重新绑。</Typography.Paragraph>
        <Input.TextArea rows={2} maxLength={100} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="为什么解绑，比如认领时手机号输错了" />
      </Modal>
    </>
  );
}
