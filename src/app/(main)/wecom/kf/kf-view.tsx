"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Empty, Input, Segmented, Space, Statistic, Tag, Typography } from "antd";
import { formatDateTime } from "@/lib/format";
import { KF_INTENT_LABELS, type KfIntent } from "@/lib/wecom-kf";
import type { KfSessionDetail, KfSessionList } from "@/server/wecom/kf-service";
import { simulateKfAction } from "./actions";

// 微信客服（总部）：左边会话列表，右边聊天记录；模拟模式下底部可以“模拟客户发消息”（新开一个老客户或新客户，或在当前会话接着发），
// 转人工后可以模拟接待人员回复、结束人工接待。每发一条都走一遍真实的回调处理。

const SAMPLES = ["你们几点关门？", "iPhone 16 Pro 多少钱？有货吗", "我的碎屏险到什么时候", "保修多久", "手机屏幕摔碎了怎么赔", "我要投诉"];

type Target = "current" | "bound" | "anon";

export function KfView({ mode, list, detail }: { mode: "real" | "simulated"; list: KfSessionList; detail: KfSessionDetail | null }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [text, setText] = useState("");
  const [target, setTarget] = useState<Target>(detail ? "current" : "bound");
  const [pending, startTransition] = useTransition();
  const simulated = mode === "simulated";

  function send(input: { text?: string; asServicer?: boolean; endSession?: boolean }) {
    startTransition(async () => {
      const result = await simulateKfAction({
        ...input,
        ...(target === "current" || input.asServicer || input.endSession ? { externalUserid: detail?.externalUserid } : { persona: target === "bound" ? "bound" : "anon" }),
      });
      if (!result.ok) {
        message.error(result.error);
        return;
      }
      setText("");
      setTarget("current");
      router.push(`/wecom/kf?session=${result.sessionId}`);
      router.refresh();
    });
  }

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        title={simulated ? "微信客服（模拟）" : "微信客服"}
        description="客户在微信里找客服号发消息，系统按关键词自动答：营业时间地址、保修政策、理赔、机型价格和哪些区域有货、我的保障（只答绑定过档案的客户）。要人工、连着两句没听懂就转人工，之后不再自动答复。企业微信规定客户发消息后 48 小时内能回、每次最多回 5 条。消息留 180 天，只有总部能看。"
      />
      <Space size="large" wrap>
        <Statistic title="会话" value={list.total} />
        <Statistic title="人工接待中" value={list.human} />
      </Space>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <Card size="small" title="会话" style={{ width: "min(300px, 100%)", flex: "none" }} styles={{ body: { padding: 0, maxHeight: 620, overflowY: "auto" } }}>
          {list.sessions.length === 0 ? (
            <Empty style={{ margin: 24 }} description="还没有客户发过消息" />
          ) : (
            list.sessions.map((s) => (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                onClick={() => router.push(`/wecom/kf?session=${s.id}`)}
                onKeyDown={(e) => (e.key === "Enter" ? router.push(`/wecom/kf?session=${s.id}`) : undefined)}
                style={{ padding: "10px 12px", borderBottom: "1px solid #f5f5f5", cursor: "pointer", background: detail?.id === s.id ? "#e6f4ff" : undefined }}
              >
                <Space size={4} wrap>
                  <Typography.Text strong>{s.customer?.name ?? `微信用户${s.externalUserid.slice(-4).toUpperCase()}`}</Typography.Text>
                  {s.customer ? null : <Tag>没绑定</Tag>}
                  {s.state === "HUMAN" ? <Tag color="orange">人工</Tag> : null}
                </Space>
                <Typography.Paragraph type="secondary" ellipsis style={{ fontSize: 12, margin: 0 }}>
                  {s.last ? `${s.last.direction === "IN" ? "" : "答："}${s.last.content}` : ""}
                </Typography.Paragraph>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {formatDateTime(s.updatedAt)}，{s.count} 条
                </Typography.Text>
              </div>
            ))
          )}
        </Card>

        <Card
          size="small"
          style={{ flex: 1, minWidth: "min(320px, 100%)" }} // 窄屏上不超过屏幕（复查第 83 条顺手）
          title={
            detail ? (
              <Space wrap>
                {detail.customer?.name ?? `微信用户${detail.externalUserid.slice(-4).toUpperCase()}`}
                {detail.customer ? <Tag color="green">已绑定档案</Tag> : <Tag>没绑定档案</Tag>}
                {detail.state === "HUMAN" ? <Tag color="orange">人工接待中</Tag> : <Tag color="blue">自动答复</Tag>}
                {detail.window.ok ? null : <Tag color="red">{detail.window.reason}</Tag>}
              </Space>
            ) : (
              "聊天记录"
            )
          }
        >
          <div style={{ background: "#f5f5f5", borderRadius: 6, padding: 12, minHeight: 360, maxHeight: 520, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
            {!detail ? (
              <Typography.Text type="secondary" style={{ textAlign: "center", marginTop: 140 }}>
                {simulated ? "左边选一个会话，或者在下面模拟一个客户发消息" : "左边选一个会话"}
              </Typography.Text>
            ) : (
              detail.messages.map((m) => {
                if (m.msgType === "event") {
                  return (
                    <Typography.Text key={m.id} type="secondary" style={{ textAlign: "center", fontSize: 12 }}>
                      {m.content === "[转人工]" || m.content === "[转人工失败]" ? `—— ${m.content.slice(1, -1)}：${m.note ?? ""} ——` : `—— ${m.content.replace(/^[|]$/g, "")} ——`}
                    </Typography.Text>
                  );
                }
                const mine = m.direction === "OUT";
                return (
                  <div key={m.id} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "80%" }}>
                    <div style={{ whiteSpace: "pre-wrap", padding: "8px 12px", borderRadius: 8, background: !m.delivered ? "#e5e5e5" : mine ? "#95ec69" : "#fff", color: m.delivered ? undefined : "#888" }}>{m.content}</div>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {formatDateTime(m.sentAt)}
                      {m.intent ? ` · ${KF_INTENT_LABELS[m.intent as KfIntent] ?? m.intent}` : ""}
                      {m.note ? ` · ${m.note}` : ""}
                      {!m.delivered ? " · 没发出去" : ""}
                    </Typography.Text>
                  </div>
                );
              })
            )}
          </div>

          {simulated ? (
            <Space orientation="vertical" style={{ width: "100%", marginTop: 12 }}>
              <Segmented<Target>
                value={detail ? target : target === "current" ? "bound" : target}
                onChange={setTarget}
                options={[...(detail ? [{ label: "在这个会话接着发", value: "current" as const }] : []), { label: "新开：已绑定的老客户", value: "bound" as const }, { label: "新开：没绑定的新客户", value: "anon" as const }]}
              />
              <Space wrap size={4}>
                {SAMPLES.map((s) => (
                  <Button key={s} size="small" onClick={() => setText(s)}>
                    {s}
                  </Button>
                ))}
              </Space>
              <Space.Compact style={{ width: "100%" }}>
                <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="以客户身份发一句话" maxLength={500} onPressEnter={() => text.trim() && send({ text })} />
                <Button type="primary" loading={pending} disabled={!text.trim()} onClick={() => send({ text })}>
                  模拟客户发送
                </Button>
              </Space.Compact>
              {detail?.state === "HUMAN" ? (
                <Space wrap>
                  <Button disabled={!text.trim() || pending} onClick={() => send({ text, asServicer: true })}>
                    以接待人员身份回复
                  </Button>
                  <Button disabled={pending} onClick={() => send({ endSession: true })}>
                    模拟结束人工接待
                  </Button>
                </Space>
              ) : null}
            </Space>
          ) : null}
        </Card>
      </div>
    </Space>
  );
}
