"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Alert, Breadcrumb, Button, Grid, Layout, Menu, Space, Tag, Typography } from "antd";
import { groupMenu, type MenuEntry } from "@/lib/menu";
import { breadcrumbFor } from "@/lib/routes";
import { logout } from "@/app/(auth)/login/actions";
import type { MyNotifications } from "@/server/alerts/alert-service";
import { NotificationBell } from "./notification-bell";

const { Header, Sider, Content } = Layout;

/** 页面顶上的提醒（到期、没完成初始化……，口径第 21 节） */
export interface ShellNotice {
  level: "info" | "warning" | "error";
  text: string;
  href?: string;
  linkText?: string;
}

export interface ShellUser {
  name: string;
  roleLabel: string;
  scopeLabel: string; // 本店名 / 辖区名 / 全部门店
}

// 登录后的外壳：左侧菜单、顶部用户信息、中间内容。第 10 天再做面包屑和手机端收起细节。
const noopSubscribe = () => () => {};

export function AppShell({
  user,
  menu,
  notifications,
  notices = [],
  children,
}: {
  user: ShellUser;
  menu: MenuEntry[];
  notifications: MyNotifications;
  notices?: ShellNotice[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // 服务端渲染和首次注水时是 false，浏览器接管后变 true（用来避免手机上菜单闪一下）
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const screens = Grid.useBreakpoint();
  const compact = !screens.md; // 手机宽度：顶栏只留姓名和退出，内容区缩小留白
  // 当前页高亮：取 href 和路径前缀匹配最长的那一项
  const selectedKey = menu
    .filter((m) => m.href && (pathname === m.href || pathname.startsWith(m.href + "/")))
    .sort((a, b) => (b.href?.length ?? 0) - (a.href?.length ?? 0))[0]?.key;
  // 一级分组（口径第 25 节）：默认只展开当前页面所在的那一组；点开别的组时收起前一组（一次只开一组，菜单不会又变得很长）
  const groups = groupMenu(menu);
  const currentGroup = groups.find((g) => g.items.some((m) => m.key === selectedKey))?.key;
  const groupKey = (k: string) => `group-${k}`;
  const [open, setOpen] = useState({ for: currentGroup, keys: currentGroup ? [groupKey(currentGroup)] : [] });
  // 换了页面、所在的组变了：只展开新的那一组（在渲染里按“上一次是哪组”调整，不用 effect）
  if (open.for !== currentGroup) setOpen({ for: currentGroup, keys: currentGroup ? [groupKey(currentGroup)] : [] });
  // 侧栏是不是收着（窄屏 < 992 默认收着，点左上角打开）：Sider 自己管开关，通过 onCollapse 告诉这里
  const [siderCollapsed, setSiderCollapsed] = useState(false);
  const crumbs = breadcrumbFor(pathname).map((c) => ({
    title: c.href ? <Link href={c.href}>{c.title}</Link> : c.title,
  }));

  return (
    <Layout style={{ minHeight: "100vh" }}>
      {/* 窄屏时菜单收起成左上角的按钮，放进顶栏（顶栏左边留了 56px），不挡内容 */}
      <Sider
        breakpoint="lg"
        collapsedWidth={0}
        theme="dark"
        zeroWidthTriggerStyle={{ top: 12 }}
        className={hydrated ? undefined : "sider-before-hydration"}
        // 窄屏自动收起、点左上角打开都会走到这里。收起时菜单会清掉展开的组；点开菜单时，重新只展开当前页面所在的那一组
        onCollapse={(collapsed) => {
          setSiderCollapsed(collapsed);
          if (!collapsed) setOpen({ for: currentGroup, keys: currentGroup ? [groupKey(currentGroup)] : [] });
        }}
      >
        <Link href="/" style={{ display: "block", color: "#fff", fontSize: 18, fontWeight: 600, padding: "16px 24px" }}>
          店有数 ERP
        </Link>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={selectedKey ? [selectedKey] : []}
          // 侧栏收着时菜单是“弹出”方式，这时给它展开的组，就会在内容上面浮出那一组的子菜单、不会消失（复查第 97 条）
          openKeys={siderCollapsed ? [] : open.keys}
          onOpenChange={(keys) => setOpen({ for: currentGroup, keys: keys.filter((k) => !open.keys.includes(k)).slice(-1) })}
          items={groups.map((g) => ({
            key: groupKey(g.key),
            label: g.label,
            children: g.items.map((m) => ({
              key: m.key,
              label: m.href ? <Link href={m.href}>{m.label}</Link> : m.label,
              disabled: !m.href,
            })),
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
            <Link href="/me" title="个人信息、改密码">
              <Typography.Text strong>{user.name}</Typography.Text>
            </Link>
            <Tag color="blue">{user.roleLabel}</Tag>
            {compact ? null : <Typography.Text type="secondary">{user.scopeLabel}</Typography.Text>}
          </Space>
          <NotificationBell data={notifications} compact={compact} />
          <form action={logout}>
            <Button htmlType="submit" size="small">
              退出
            </Button>
          </form>
        </Header>
        <Content style={{ padding: compact ? 12 : 24, minWidth: 0 }}>
          {/* 手机端页面要一屏放下，不显示面包屑 */}
          {notices.map((n) => (
            <Alert
              key={n.text}
              type={n.level}
              showIcon
              style={{ marginBottom: 12 }}
              title={n.text}
              action={n.href ? <Link href={n.href}>{n.linkText ?? "去处理"}</Link> : undefined}
            />
          ))}
          {pathname.startsWith("/m/") ? null : <Breadcrumb items={crumbs} style={{ marginBottom: compact ? 12 : 16 }} />}
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}
