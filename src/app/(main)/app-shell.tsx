"use client";

import { Button, Layout, Menu, Space, Tag, Typography } from "antd";
import type { MenuEntry } from "@/server/auth/permissions";
import { logout } from "@/app/(auth)/login/actions";

const { Header, Sider, Content } = Layout;

export interface ShellUser {
  name: string;
  roleLabel: string;
  scopeLabel: string; // 本店名 / 辖区名 / 全部门店
}

// 登录后的外壳：左侧菜单、顶部用户信息、中间内容。第 10 天再做面包屑和手机端收起细节。
export function AppShell({
  user,
  menu,
  children,
}: {
  user: ShellUser;
  menu: MenuEntry[];
  children: React.ReactNode;
}) {
  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider breakpoint="lg" collapsedWidth={0} theme="dark">
        <div style={{ color: "#fff", fontSize: 18, fontWeight: 600, padding: "16px 24px" }}>店有数 ERP</div>
        <Menu theme="dark" mode="inline" items={menu.map((m) => ({ key: m.key, label: m.label }))} />
      </Sider>
      <Layout>
        <Header
          style={{
            background: "#fff",
            padding: "0 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 12,
          }}
        >
          <Space>
            <Typography.Text strong>{user.name}</Typography.Text>
            <Tag color="blue">{user.roleLabel}</Tag>
            <Typography.Text type="secondary">{user.scopeLabel}</Typography.Text>
          </Space>
          <form action={logout}>
            <Button htmlType="submit" size="small">
              退出
            </Button>
          </form>
        </Header>
        <Content style={{ padding: 24 }}>{children}</Content>
      </Layout>
    </Layout>
  );
}
