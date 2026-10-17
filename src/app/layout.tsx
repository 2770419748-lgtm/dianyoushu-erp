import type { Metadata, Viewport } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "店有数 ERP",
  description: "手机零售门店经营系统演示版",
  // 苹果手机"添加到主屏幕"用：全屏打开、桌面上的名字和图标（安卓读 app/manifest.ts）
  appleWebApp: { capable: true, title: "店有数", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#1677ff",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // 让底部固定栏能用 safe-area 避开 iPhone 的小白条
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
