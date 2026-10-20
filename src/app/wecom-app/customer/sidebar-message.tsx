"use client";

import { Result } from "antd";

// 侧边栏里的提示页（登录过期、没选客户、不是你的好友）
export function SidebarMessage({ status = "info", title, subTitle }: { status?: "info" | "warning"; title: string; subTitle?: string }) {
  return <Result status={status} title={title} subTitle={subTitle} />;
}
