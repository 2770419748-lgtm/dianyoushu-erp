"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Popconfirm, Space, Tag, Typography } from "antd";
import { formatDateTime } from "@/lib/format";
import type { NoticeDetail } from "@/server/notice/notice-service";
import { withdrawNoticeAction } from "../actions";

export function NoticeDetailView({ notice }: { notice: NoticeDetail }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  return (
    <Card
      title={
        <Space wrap>
          {notice.title}
          {notice.withdrawn ? <Tag>已撤下</Tag> : null}
        </Space>
      }
      extra={
        notice.canWithdraw ? (
          <Popconfirm
            title="撤下后大家都看不到了，确定？"
            onConfirm={() =>
              startTransition(async () => {
                const r = await withdrawNoticeAction(notice.id);
                if (r.ok) message.success(r.message);
                else message.error(r.error);
                router.refresh();
              })
            }
          >
            <Button danger loading={pending}>
              撤下
            </Button>
          </Popconfirm>
        ) : null
      }
    >
      <Typography.Paragraph type="secondary">
        {notice.author}，{formatDateTime(notice.createdAt)}
      </Typography.Paragraph>
      <Typography.Paragraph style={{ whiteSpace: "pre-wrap", fontSize: 15 }}>{notice.body}</Typography.Paragraph>
      {notice.reads ? (
        <Alert
          type="info"
          showIcon
          title={`已读 ${notice.reads.readCount} / 发给 ${notice.reads.recipients} 人`}
          description={notice.reads.unread.length > 0 ? `还没读：${notice.reads.unread.join("、")}${notice.reads.unread.length >= 50 ? " 等" : ""}` : "都读了"}
        />
      ) : null}
    </Card>
  );
}
