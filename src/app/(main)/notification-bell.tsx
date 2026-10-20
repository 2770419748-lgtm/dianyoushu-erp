"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Empty, Popover, Space, Typography } from "antd";
import { formatDateTime } from "@/lib/format";
import type { MyNotifications } from "@/server/alerts/alert-service";
import { markAllReadAction, markReadAction } from "./notification-actions";

// 顶栏的消息（口径第 18 节）：智能提醒的今日待办发到这里，不依赖外网。点一条标已读并打开。
export function NotificationBell({ data, compact }: { data: MyNotifications; compact: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function open(id: number, link: string | null) {
    startTransition(async () => {
      await markReadAction(id);
      router.push(link ?? "/alerts");
      router.refresh();
    });
  }

  const content = (
    <div style={{ width: compact ? 280 : 340 }}>
      {data.items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有消息" />
      ) : (
        data.items.map((n) => (
          <div
            key={n.id}
            role="button"
            tabIndex={0}
            onClick={() => open(n.id, n.link)}
            onKeyDown={(e) => (e.key === "Enter" ? open(n.id, n.link) : undefined)}
            style={{ padding: "8px 4px", borderBottom: "1px solid #f0f0f0", cursor: "pointer", opacity: n.readAt ? 0.6 : 1 }}
          >
            <Space size={6}>
              {n.readAt ? null : <Badge status="processing" />}
              <Typography.Text strong={!n.readAt}>{n.title}</Typography.Text>
            </Space>
            <div style={{ fontSize: 12, color: "#666" }}>{n.body}</div>
            <div style={{ fontSize: 11, color: "#999" }}>{formatDateTime(n.updatedAt)}</div>
          </div>
        ))
      )}
      <Space style={{ marginTop: 8, width: "100%", justifyContent: "space-between" }}>
        <Button size="small" type="link" onClick={() => router.push("/alerts")}>
          看智能提醒
        </Button>
        <Button
          size="small"
          disabled={data.unread === 0 || pending}
          onClick={() =>
            startTransition(async () => {
              await markAllReadAction();
              router.refresh();
            })
          }
        >
          全部已读
        </Button>
      </Space>
    </div>
  );

  return (
    <Popover content={content} title="消息" trigger="click" placement="bottomRight">
      <Badge count={data.unread} size="small" overflowCount={99}>
        <Button size="small">消息</Button>
      </Badge>
    </Popover>
  );
}
