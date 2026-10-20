"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Result, Spin } from "antd";

// 真对接时：在企业微信里加载 JS-SDK，用应用身份签名（agentConfig），再问企业微信“当前聊天的是哪个客户”（getCurExternalContact），
// 拿到客户 id 填进地址，交给服务端核对好友关系、查画像。模拟模式不用这个组件。
// 页面的内容安全策略带 'strict-dynamic'：本站带 nonce 的脚本动态插入的 <script> 能运行，所以不用按域名放行。
// 这一段要在企业微信真机上联调（官方 SDK 的地址、版本以文档为准），演示里用不到。

type Wx = {
  agentConfig(options: { corpid: string; agentid: string; timestamp: number; nonceStr: string; signature: string; jsApiList: string[]; success: () => void; fail: (res: { errMsg?: string }) => void }): void;
  invoke(name: string, args: Record<string, unknown>, callback: (res: { err_msg?: string; userId?: string }) => void): void;
};

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`加载不了 ${src}`));
    document.head.appendChild(el);
  });
}

export function RealContactLoader({ scripts }: { scripts: string[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const src of scripts) await loadScript(src);
      const wx = (window as unknown as { wx?: Wx }).wx;
      if (!wx) throw new Error("没在企业微信里打开，或者 JS-SDK 没加载上");
      const res = await fetch(`/wecom-app/api/signature?url=${encodeURIComponent(location.href.split("#")[0]!)}`);
      const sign = (await res.json()) as { corpId: string; agentId: string; timestamp: number; nonceStr: string; signature: string; error?: string };
      if (!res.ok) throw new Error(sign.error ?? "签名没拿到");
      await new Promise<void>((resolve, reject) =>
        wx.agentConfig({ corpid: sign.corpId, agentid: sign.agentId, timestamp: sign.timestamp, nonceStr: sign.nonceStr, signature: sign.signature, jsApiList: ["getCurExternalContact"], success: resolve, fail: (r) => reject(new Error(r.errMsg ?? "agentConfig 失败")) }),
      );
      const userId = await new Promise<string>((resolve, reject) =>
        wx.invoke("getCurExternalContact", {}, (r) => (r.err_msg === "getCurExternalContact:ok" && r.userId ? resolve(r.userId) : reject(new Error(r.err_msg ?? "拿不到当前客户")))),
      );
      if (!cancelled) router.replace(`/wecom-app/customer?externalUserid=${encodeURIComponent(userId)}`);
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [router, scripts]);

  if (error) return <Result status="warning" title="没拿到当前聊天的客户" subTitle={`${error}。要在企业微信和客户的聊天窗口里，从工具栏打开。`} />;
  return (
    <div style={{ textAlign: "center", paddingTop: 80 }}>
      <Spin />
      <div style={{ marginTop: 12, color: "#888" }}>正在识别当前聊天的客户…</div>
    </div>
  );
}
