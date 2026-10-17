import type { MetadataRoute } from "next";

// PWA 清单：手机浏览器"添加到主屏幕"后，像 App 一样全屏打开、有自己的图标。
// 不做离线缓存（ERP 数据要实时），所以没有 service worker；以后要打包成 App 也从这里起步。
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "店有数 ERP",
    short_name: "店有数",
    description: "手机零售门店经营系统演示版",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f5f5f5",
    theme_color: "#1677ff",
    lang: "zh-CN",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "手机开单", url: "/m/sale" },
      { name: "查库存", url: "/m/stock" },
    ],
  };
}
