"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Breadcrumb, Button, Grid, Layout, Menu, Space, Tag, Typography } from "antd";
import type { MenuEntry } from "@/server/auth/permissions";
import { breadcrumbFor } from "@/lib/routes";
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
  const pathname = usePathname();
  const screens = Grid.useBreakpoint();
  const compact = !screens.md; // 手机宽度：顶栏只留姓名和退出，内容区缩小留白
  // 当前页高亮：取 href 和路径前缀匹配最长的那一项
  const selectedKey = menu
    .filter((m) => m.href && (pathname === m.href || pathname.startsWith(m.href + "/")))
    .sort((a, b) => (b.href?.length ?? 0) - (a.href?.length ?? 0))[0]?.key;
  const crumbs = breadcrumbFor(pathname).map((c) => ({
    title: c.href ? <Link href={c.href}>{c.title}</Link> : c.title,
  }));

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider breakpoint="lg" collapsedWidth={0} theme="dark">
        <Link href="/" style={{ display: "block", color: "#fff", fontSize: 18, fontWeight: 600, padding: "16px 24px" }}>
          店有数 ERP
        </Link>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={selectedKey ? [selectedKey] : []}
          items={menu.map((m) => ({
            key: m.key,
            label: m.href ? <Link href={m.href}>{m.label}</Link> : m.label,
            disabled: !m.href,
          }))}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: "#fff",
            padding: compact ? "0 12px 0 56px" : "0 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 12,
            overflow: "hidden",
          }}
        >
          <Space size="small" wrap={false} style={{ whiteSpace: "nowrap" }}>
            <Typography.Text strong>{user.name}</Typography.Text>
            <Tag color="blue">{user.roleLabel}</Tag>
            {compact ? null : <Typography.Text type="secondary">{user.scopeLabel}</Typography.Text>}
          </Space>
          <form action={logout}>
            <Button htmlType="submit" size="small">
              退出
            </Button>
          </form>
        </Header>
        <Content style={{ padding: compact ? 12 : 24, minWidth: 0 }}>
          <Breadcrumb items={crumbs} style={{ marginBottom: compact ? 12 : 16 }} />
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}
