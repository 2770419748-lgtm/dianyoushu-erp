"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Empty, Input, Space, Tag, Typography } from "antd";
import { SimpleList } from "@/components/simple-list";
import { entitlementStateLabel, REMINDER_T30_MAX_DAYS } from "@/lib/entitlement";
import { formatDate, formatFen } from "@/lib/format";
import type { SidebarProfile } from "@/server/wecom/sidebar-service";
import { claimCustomerAction } from "./actions";

// 侧边栏的客户画像：窄屏（企业微信工具栏大约 360 像素宽），一张张小卡片往下排。只读，唯一能做的是认领绑定。

const STATE_COLORS: Record<string, string> = { 保障中: "green", 即将到期: "orange", 未生效: "blue", 已过期: "default", 已失效: "default", 已理赔: "purple" };
const ORDER_STATUS: Record<string, string> = { COMPLETED: "已完成", VOIDED: "已作废" };

function ClaimCard({ externalUserid, nickname, demoHint }: { externalUserid: string; nickname: string | null; demoHint: { name: string; phone: string } | null }) {
  const { message } = App.useApp();
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  async function claim() {
    setBusy(true);
    try {
      const result = await claimCustomerAction(externalUserid, phone);
      if (!result.ok) {
        message.error(result.error);
        return;
      }
      message.success(`已绑定到客户 ${result.name}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card size="small" title={`${nickname ?? "这个好友"}还没绑定客户档案`}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        问客户要完整的手机号，输进来绑定到他的客户档案。手机号要和档案完全一样；客户已经绑了别的微信的不能再绑。
      </Typography.Paragraph>
      <Space.Compact style={{ width: "100%" }}>
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="客户的 11 位手机号" maxLength={13} inputMode="numeric" onPressEnter={claim} />
        <Button type="primary" loading={busy} onClick={claim} disabled={phone.replace(/\s/g, "").length !== 11}>
          绑定
        </Button>
      </Space.Compact>
      {demoHint ? <Alert style={{ marginTop: 12 }} type="info" showIcon title={`演示提示：可以用 ${demoHint.name} 的手机号 ${demoHint.phone} 试（你开过单、还没绑定微信的客户）`} /> : null}
    </Card>
  );
}

export function SidebarProfileView({ profile, externalUserid, demoHint }: { profile: SidebarProfile; externalUserid: string; demoHint: { name: string; phone: string } | null }) {
  if (!profile.bound) return <ClaimCard externalUserid={externalUserid} nickname={profile.nickname} demoHint={demoHint} />;
  const { customer, orders, orderCount, entitlements, devices, tags, follows } = profile;
  const activeEntitlements = entitlements.filter((e) => e.status === "ACTIVE");
  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <Card size="small">
        <Space orientation="vertical" size={4} style={{ width: "100%" }}>
          <Space wrap>
            <Typography.Text strong style={{ fontSize: 16 }}>
              {customer.name}
            </Typography.Text>
            <Typography.Text type="secondary">{customer.phoneMasked}</Typography.Text>
            {profile.nickname ? <Tag>微信：{profile.nickname}</Tag> : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            跟进：{follows.map((f) => (f.store ? `${f.staff}（${f.store}）` : f.staff)).join("、") || "-"}
          </Typography.Text>
          {tags.length > 0 ? (
            <div>
              {tags.map((t) => (
                <Tag key={`${t.group}-${t.name}`} color="blue" style={{ marginBottom: 4 }}>
                  {t.name}
                </Tag>
              ))}
            </div>
          ) : null}
        </Space>
      </Card>

      <Card size="small" title={`碎屏险和延保（保障中 ${activeEntitlements.length}）`}>
        {entitlements.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没买过" />
        ) : (
          <SimpleList
            items={entitlements}
            rowKey={(e) => e.id}
            render={(e) => {
              const label = entitlementStateLabel(e.status, e.daysLeft, e.daysToStart);
              return (
                <Space orientation="vertical" size={0} style={{ width: "100%" }}>
                  <Space wrap>
                    <span>{e.sku.name}</span>
                    <Tag color={STATE_COLORS[label]}>{label}</Tag>
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    到 {formatDate(e.expiresOn)}
                    {e.status === "ACTIVE" && e.daysLeft >= 0 ? (
                      <Typography.Text type={e.daysLeft <= REMINDER_T30_MAX_DAYS ? "danger" : "secondary"} style={{ fontSize: 12 }}>
                        {`，还剩 ${e.daysLeft} 天`}
                      </Typography.Text>
                    ) : null}
                    {e.device ? `，保 ${e.device.code}` : ""}
                  </Typography.Text>
                </Space>
              );
            }}
          />
        )}
      </Card>

      <Card size="small" title={`买过的机器（${devices.length}）`}>
        {devices.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有在店里买过机器" />
        ) : (
          <SimpleList
            items={devices}
            rowKey={(d) => d.key}
            render={(d) => (
              <Space orientation="vertical" size={0}>
                <span>{d.name}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {d.code}，{formatDate(d.boughtOn)} 在{d.store}买，
                  {d.warrantyDaysLeft >= 0 ? `保修到 ${formatDate(d.warrantyEnds)}` : `保修 ${formatDate(d.warrantyEnds)} 已过`}
                </Typography.Text>
              </Space>
            )}
          />
        )}
      </Card>

      <Card size="small" title={`最近的单（共 ${orderCount} 张）`}>
        {orders.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有单" />
        ) : (
          <SimpleList
            items={orders}
            rowKey={(o) => o.key}
            render={(o) => (
              <Space orientation="vertical" size={0} style={{ width: "100%" }}>
                <Space wrap>
                  <span>{formatDate(o.bizDate)}</span>
                  <span>{formatFen(o.totalFen)} 元</span>
                  {o.status !== "COMPLETED" ? <Tag>{ORDER_STATUS[o.status] ?? o.status}</Tag> : null}
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {o.store}，{o.summary}
                  {o.orderNo ? `，${o.orderNo}` : ""}
                </Typography.Text>
              </Space>
            )}
          />
        )}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
          开单、退货请回 ERP 操作；别人开的单这里只显示摘要。
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}
