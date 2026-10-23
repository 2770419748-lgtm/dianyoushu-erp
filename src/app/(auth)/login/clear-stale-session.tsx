"use client";

import { useEffect } from "react";

// 登录已失效时（账号停用、改过密码），浏览器里还留着旧的登录 cookie：进登录页时发一次 POST 把它清掉（口径第 20 节）。
// 不清也能重新登录（新 cookie 会盖掉旧的），清掉是免得旧 cookie 一直带着。
export function ClearStaleSession() {
  useEffect(() => {
    void fetch("/api/session/clear", { method: "POST" }).catch(() => undefined);
  }, []);
  return null;
}
