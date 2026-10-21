"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Empty, Segmented, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { MarkdownLite } from "@/components/markdown-lite";
import { ALERT_KIND_LABELS, type AlertKindKey } from "@/lib/alerts";
import { formatDateTime } from "@/lib/format";
import type { AlertsPage } from "@/server/alerts/alert-service";
import { runAlertsAction } from "./actions";

// 智能提醒：上面选看哪份今日待办（门店、区域、总部），中间是待办正文，下面是这份待办背后命中的规则明细（程序算的数字）。

type Item = AlertsPage["items"][number];

const SOURCE: Record<string, { label: string; color: string; note: string }> = {
  MODEL: { label: "AI 生成", color: "purple", note: "大模型排的先后、写的话，数字以系统为准（程序校验过每个数字）" },
  SIMULATED: { label: "模拟模型", color: "geekblue", note: "演示站没配大模型，用模拟模型写的，走的是和真模型同一套校验" },
  TEMPLATE: { label: "模板", color: "default", note: "按模板生成" },
};

const PUSH: Record<string, string> = { SENT: "已推到门店群", SIMULATED: "演示：没有真推门店群", NONE: "门店没填群机器人地址", FAILED: "推门店群失败" };

const SEVERITY: Record<number, { label: string; color: string }> = { 3: { label: "很急", color: "red" }, 2: { label: "要紧", color: "orange" }, 1: { label: "一般", color: "default" } };

export function AlertsView({ data }: { data: AlertsPage }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const digest = data.digests.find((d) => d.id === data.selected) ?? null;
  const items = digest ? data.items.filter((i) => i.scopeKey === digest.scopeKey) : [];

  const columns: TableColumnsType<Item> = [
    { title: "轻重", dataIndex: "severity", width: 70, render: (v: number) => <Tag color={SEVERITY[v]?.color}>{SEVERITY[v]?.label}</Tag> },
    { title: "提醒", dataIndex: "kind", width: 110, render: (k: AlertKindKey) => ALERT_KIND_LABELS[k] ?? k },
    { title: "程序算的", dataIndex: "detail" },
    { title: "", dataIndex: "link", width: 80, render: (v: string | null) => (v ? <Link href={v}>去处理</Link> : null) },
  ];

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        title="智能提醒"
        description="程序每天早上 9 点、晚上 9 点按规则找出要处理的事（滞销、缺货、KPI 落后、日结、调拨、盘点、回收机、审批、调拨建议、对账），把数字算好；大模型只负责排先后、写成今日待办，写的每个数字都要在程序给的清单里，对不上就改用模板。"
      />
      <Card
        title={`今日待办 · ${data.date}`}
        extra={
          data.canRun ? (
            <Button
              type="primary"
              loading={pending}
              onClick={() =>
                startTransition(async () => {
                  const r = await runAlertsAction();
                  if (r.ok) message.success(r.message);
                  else message.error(r.error);
                  router.refresh();
                })
              }
            >
              立即生成
            </Button>
          ) : null
        }
      >
        {data.digests.length === 0 ? (
          <Empty description="今天没有要处理的事（或者还没生成）" />
        ) : (
          <Space orientation="vertical" style={{ width: "100%" }}>
            {data.digests.length > 1 ? (
              <Segmented
                value={data.selected ?? undefined}
                onChange={(v) => router.push(`/alerts?digest=${v}`)}
                options={data.digests.map((d) => ({ value: d.id, label: d.title.replace(/ 今日待办.*$/, "") }))}
                style={{ maxWidth: "100%", overflowX: "auto" }}
              />
            ) : null}
            {digest ? (
              <>
                <Space wrap size={4}>
                  <Tag color={SOURCE[digest.source]?.color}>{SOURCE[digest.source]?.label}</Tag>
                  {digest.pushStatus ? <Tag color={digest.pushStatus === "FAILED" ? "red" : digest.pushStatus === "SENT" ? "green" : "default"}>{PUSH[digest.pushStatus] ?? digest.pushStatus}</Tag> : null}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {formatDateTime(digest.generatedAt)} 生成，{digest.itemCount} 件事
                  </Typography.Text>
                </Space>
                {digest.fallbackReason ? <Alert type="warning" showIcon title={`这份没用模型写：${digest.fallbackReason}`} /> : null}
                {digest.pushError ? <Alert type="error" showIcon title={`推门店群失败：${digest.pushError}`} /> : null}
                <div style={{ background: "#fafafa", border: "1px solid #f0f0f0", borderRadius: 8, padding: 16 }}>
                  <MarkdownLite text={digest.content} />
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {SOURCE[digest.source]?.note}
                </Typography.Text>
              </>
            ) : null}
          </Space>
        )}
      </Card>
      {data.llm ? (
        <Card title="大模型">
          <Space orientation="vertical" style={{ width: "100%" }}>
            <Typography.Text>
              现在的写法：{data.llm.mode === "real" ? `真模型（${data.llm.model}），每天最多调 ${data.llm.dailyLimit} 次` : data.llm.mode === "simulated" ? "模拟模型（演示站没配大模型，按清单排序加固定建议）" : "只发模板版（没开大模型）"}
            </Typography.Text>
            <Typography.Text type="secondary">
              今天调了 {data.llm.calls} 次，失败 {data.llm.failed} 次，用了输入 {data.llm.promptTokens} / 输出 {data.llm.completionTokens} 个 token。只记成没成和 token，不存提示和回答的全文。
            </Typography.Text>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={data.llm.recent}
              locale={{ emptyText: "还没调过" }}
              columns={[
                { title: "时间", dataIndex: "createdAt", render: (v: Date) => formatDateTime(v) },
                { title: "模型", dataIndex: "model" },
                { title: "结果", render: (_, r) => (r.ok ? <Tag color="green">成功</Tag> : <Tag color="red">{r.error ?? "失败"}</Tag>) },
                { title: "token（入/出）", render: (_, r) => `${r.promptTokens} / ${r.completionTokens}` },
                { title: "耗时", dataIndex: "latencyMs", render: (v: number) => `${v} 毫秒` },
              ]}
            />
          </Space>
        </Card>
      ) : null}
      {digest ? (
        <Card title="命中的规则（程序算的数字）">
          <Table rowKey="id" size="small" columns={columns} dataSource={items} pagination={false} scroll={{ x: true }} />
        </Card>
      ) : null}
    </Space>
  );
}
