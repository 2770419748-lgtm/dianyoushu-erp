"use client";

import { useState } from "react";
import { Alert, Avatar, Card, Empty, Space, Tag, Typography } from "antd";
import type { listMyContacts } from "@/server/wecom/sidebar-service";

type Contacts = Awaited<ReturnType<typeof listMyContacts>>;

// 模拟的企业微信聊天窗口：左边好友列表，中间是聊天区（演示用的假消息），右边是侧边栏（iframe 打开真正的 /wecom-app 页面）。
// 点好友时 iframe 先去 /wecom-app/auth?sim=1，按我自己发侧边栏的票，再跳到客户画像：和真用时一样是两套登录。

export function SidebarDemoView({ mode, data }: { mode: "real" | "simulated"; data: Contacts | null }) {
  const [selected, setSelected] = useState<string | null>(null);

  if (mode === "real" || !data) {
    return (
      <Card title="企微侧边栏">
        <Typography.Paragraph>侧边栏在企业微信里用：员工和客户聊天时，点聊天框上方工具栏里的“客户画像”。</Typography.Paragraph>
        <Typography.Paragraph>
          企业微信后台配置：应用管理 → 本应用 → 配置到聊天工具栏，页面地址填本站的 <Typography.Text code>/wecom-app/customer</Typography.Text>
          ；应用还要设可信域名（要和企业主体一致的备案域名）。
        </Typography.Paragraph>
      </Card>
    );
  }

  if (!data.hasWecom) {
    return (
      <Card title="企微侧边栏（模拟）">
        <Empty description="你还没在 ERP 里填企业微信账号，没有企业微信好友。找总部在组织管理里填上。" />
      </Card>
    );
  }

  const current = data.contacts.find((c) => c.externalUserid === selected) ?? null;
  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        title="模拟的企业微信聊天窗口"
        description="左边是你的企业微信好友。点一个，右边就是员工在企业微信里看到的侧边栏：用侧边栏自己的登录票，只能看自己的好友；没绑定档案的好友可以按完整手机号认领。"
      />
      <div style={{ display: "flex", gap: 0, border: "1px solid #e5e5e5", borderRadius: 8, overflow: "hidden", background: "#fff", minHeight: 660, flexWrap: "wrap" }}>
        <div style={{ width: 240, borderRight: "1px solid #eee", maxHeight: 660, overflowY: "auto" }}>
          {data.contacts.length === 0 ? (
            <Empty style={{ marginTop: 80 }} description="还没有企业微信好友" />
          ) : (
            data.contacts.map((c) => (
              <div
                key={c.externalUserid}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(c.externalUserid)}
                onKeyDown={(e) => (e.key === "Enter" ? setSelected(c.externalUserid) : undefined)}
                style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "10px 12px", borderBottom: "1px solid #f5f5f5", background: c.externalUserid === selected ? "#e6f4ff" : undefined }}
              >
                <Avatar style={{ background: c.name ? "#1677ff" : "#bbb", flex: "none" }}>{(c.name ?? c.nickname ?? "微")[0]}</Avatar>
                <div style={{ minWidth: 0 }}>
                  <div>{c.name ?? c.nickname ?? `微信用户${c.externalUserid.slice(-4).toUpperCase()}`}</div>
                  {c.name ? null : <Tag color="orange">没绑定档案</Tag>}
                </div>
              </div>
            ))
          )}
        </div>
        <div style={{ flex: 1, minWidth: 220, padding: 16, background: "#f7f7f7", display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 8 }}>
          {current ? (
            <>
              <div style={{ alignSelf: "flex-start", background: "#fff", padding: "8px 12px", borderRadius: 8, maxWidth: "80%" }}>你好，我上次买的手机保修到什么时候？</div>
              <div style={{ alignSelf: "flex-end", background: "#95ec69", padding: "8px 12px", borderRadius: 8, maxWidth: "80%" }}>稍等，我帮你查一下～</div>
              <Typography.Text type="secondary" style={{ textAlign: "center", fontSize: 12 }}>
                （聊天内容是演示用的假消息，系统不存聊天记录）
              </Typography.Text>
            </>
          ) : (
            <Typography.Text type="secondary" style={{ textAlign: "center", marginBottom: "auto", marginTop: 200 }}>
              选一个好友开始聊天
            </Typography.Text>
          )}
        </div>
        <div style={{ width: 360, borderLeft: "1px solid #eee" }}>
          {current ? (
            <iframe
              key={current.externalUserid}
              title="企微侧边栏"
              src={`/wecom-app/auth?sim=1&externalUserid=${encodeURIComponent(current.externalUserid)}`}
              style={{ width: 360, height: 660, border: 0, display: "block" }}
            />
          ) : (
            <Empty style={{ marginTop: 200 }} description="侧边栏" />
          )}
        </div>
      </div>
    </Space>
  );
}
