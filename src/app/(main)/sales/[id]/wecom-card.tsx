"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Space, Tag, Typography } from "antd";
import { formatDate, formatDateTime } from "@/lib/format";
import type { OrderWecomCard } from "@/server/wecom/contact-service";
import { createBindCodeAction, simulateScanAction } from "./wecom-actions";

/** 小票和完成页上的引导话术（PRD 第 15 节默认稿，坤总可以改） */
const GUIDE = "扫码加企业微信，电子保修卡和发票发您微信上；保修、碎屏险和延保到期我们提前提醒您。";

// 销售单详情页的“加企业微信”：给这张单的客户生成一次性二维码（只认这个客户），客户扫码加店员企业微信后自动绑到客户档案。
export function WecomOrderCard({ salesOrderId, card }: { salesOrderId: number; card: OrderWecomCard }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();

  function act(fn: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>) {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        if (result.message) message.success(result.message, 6);
        router.refresh();
      } else {
        message.error(result.error);
      }
    });
  }

  const title = (
    <Space>
      <span>加企业微信</span>
      {card.mode === "simulated" ? <Tag color="purple">模拟</Tag> : <Tag color="green">已对接</Tag>}
    </Space>
  );

  let body: React.ReactNode;
  if (!card.customer) {
    body = <Typography.Text type="secondary">散客单没有客户档案，绑不了企业微信。</Typography.Text>;
  } else if (card.customer.bound) {
    body = (
      <Typography.Text>
        客户 {card.customer.name} 已经加了企业微信{card.customer.nickname ? `（微信昵称：${card.customer.nickname}）` : ""}
        {card.customer.boundAt ? `，${formatDateTime(card.customer.boundAt)} 绑定` : ""}。
      </Typography.Text>
    );
  } else if (card.code) {
    body = (
      <Space align="start" size="large" wrap>
        {card.code.qrCodeUrl ? (
          // 二维码图片直接用企业微信返回的地址，不自己生成
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.code.qrCodeUrl} alt="加企业微信二维码" width={160} height={160} />
        ) : (
          <div style={{ width: 160, height: 160, border: "1px dashed #bbb", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 8 }}>
            <Typography.Text type="secondary">模拟二维码</Typography.Text>
            <Typography.Text code>{card.code.code}</Typography.Text>
          </div>
        )}
        <Space orientation="vertical">
          <Typography.Text strong>{GUIDE}</Typography.Text>
          <Typography.Text type="secondary">
            这张码只认客户 {card.customer.name}，接待人是开单的 {card.salesperson.name}；{formatDate(card.code.expiresAt)} 前有效，客户加上后自动绑到客户档案。
          </Typography.Text>
          {card.mode === "simulated" ? (
            <>
              <Alert type="info" showIcon title="演示用：没连企业微信。点下面的按钮假装客户扫了码，会造一条加密的加好友事件，走一遍真实的回调处理（验签、解密、去重、按码绑定、发欢迎语、写操作日志）。" />
              <Button type="primary" loading={pending} onClick={() => act(() => simulateScanAction(card.code!.code))}>
                模拟客户扫码加好友
              </Button>
            </>
          ) : null}
        </Space>
      </Space>
    );
  } else if (card.canCreate) {
    body = card.salesperson.hasWecom ? (
      <Space orientation="vertical">
        <Typography.Text type="secondary">给客户 {card.customer.name} 生成一张专属二维码，客户扫码加开单人 {card.salesperson.name} 的企业微信，加上后自动绑到客户档案（不按手机号猜，防错绑）。</Typography.Text>
        <Button loading={pending} onClick={() => act(() => createBindCodeAction(salesOrderId))}>
          生成加企业微信二维码
        </Button>
      </Space>
    ) : (
      <Typography.Text type="secondary">开单人 {card.salesperson.name} 还没填企业微信账号，总部在组织管理里填上后才能生成二维码。</Typography.Text>
    );
  } else {
    body = <Typography.Text type="secondary">这张单不能生成二维码（作废的单，或你没有这张单的操作权限）。</Typography.Text>;
  }

  return <Card title={title}>{body}</Card>;
}
