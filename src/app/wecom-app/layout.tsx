// 企微侧边栏的页面（口径第 12 节第三步）：不套 ERP 的菜单和顶栏，按企业微信聊天工具栏的窄屏排版；登录用侧边栏自己的票。
export default function WecomAppLayout({ children }: LayoutProps<"/wecom-app">) {
  return <div style={{ minHeight: "100vh", background: "#f5f5f5", padding: 12, boxSizing: "border-box" }}>{children}</div>;
}
