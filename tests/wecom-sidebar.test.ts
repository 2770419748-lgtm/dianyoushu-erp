import { beforeAll, describe, expect, it } from "vitest";
import { getMenuForRole } from "@/server/auth/permissions";
import { signSessionToken, verifySessionToken } from "@/server/auth/token";
import { buildOAuthUrl } from "@/server/wecom/config";
import { agentConfigSignature } from "@/server/wecom/crypto";
import { signSidebarToken, verifySidebarToken } from "@/server/wecom/sidebar-token";

// 企微侧边栏（口径第 12 节第三步）：侧边栏的票和 ERP 登录票互不相认；JS-SDK 签名；网页授权地址；菜单。纯函数，不连库。

beforeAll(() => {
  process.env.SESSION_SECRET ??= "test-session-secret-0123456789";
});

const later = () => new Date(Date.now() + 3600 * 1000);

describe("侧边栏的票", () => {
  it("签出来能验回来；过期的不认", async () => {
    const token = await signSidebarToken({ userId: 7, sv: 2, wecomUserid: "zhangsan" }, later());
    expect(await verifySidebarToken(token)).toEqual({ userId: 7, sv: 2, wecomUserid: "zhangsan" });
    const expired = await signSidebarToken({ userId: 7, sv: 2, wecomUserid: "zhangsan" }, new Date(Date.now() - 1000));
    expect(await verifySidebarToken(expired)).toBeNull();
    expect(await verifySidebarToken(undefined)).toBeNull();
    expect(await verifySidebarToken("abc.def.ghi")).toBeNull();
  });

  it("侧边栏的票进不了 ERP，ERP 的登录票也当不了侧边栏的票", async () => {
    const sidebar = await signSidebarToken({ userId: 7, sv: 0, wecomUserid: "zhangsan" }, later());
    expect(await verifySessionToken(sidebar)).toBeNull();
    const erp = await signSessionToken({ userId: 7, sv: 0 }, later());
    expect(await verifySessionToken(erp)).toEqual({ userId: 7, sv: 0 });
    expect(await verifySidebarToken(erp)).toBeNull();
  });
});

describe("JS-SDK 签名和网页授权", () => {
  it("agentConfig 签名按 jsapi_ticket、noncestr、timestamp、url 拼好取 sha1（微信 JS-SDK 文档的示例）；url 去掉 # 后面", () => {
    const ticket = "sM4AOVdWfPE4DxkXGEs8VMCPGGVi4C3VM0P37wVUCFvkVAy_90u5h9nbSlYy3-Sl-HhTdfl2fzFy1AOcHKP7qg";
    expect(agentConfigSignature(ticket, "Wm3WZYTPz0wzccnW", 1414587457, "http://mp.weixin.qq.com?params=value")).toBe("0f9de62fce790f9a083d5c99e95740ceb90c27ed");
    expect(agentConfigSignature(ticket, "Wm3WZYTPz0wzccnW", 1414587457, "http://mp.weixin.qq.com?params=value#top")).toBe("0f9de62fce790f9a083d5c99e95740ceb90c27ed");
  });

  it("网页授权地址：静默授权、带应用 id、回调地址编码、state", () => {
    const url = new URL(buildOAuthUrl({ corpId: "ww123", agentId: "1000002", redirectUri: "https://erp.example.com/wecom-app/auth", state: "abc" }));
    expect(url.origin + url.pathname).toBe("https://open.weixin.qq.com/connect/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ appid: "ww123", agentid: "1000002", redirect_uri: "https://erp.example.com/wecom-app/auth", scope: "snsapi_base", response_type: "code", state: "abc" });
    expect(url.hash).toBe("#wechat_redirect");
  });
});

describe("菜单", () => {
  it("企业微信开着时店员、店长多一个“企微侧边栏”，总部是“企微对接”；关着时都没有", () => {
    expect(getMenuForRole("STAFF", { wecom: true }).map((m) => m.key)).toContain("wecom-sidebar");
    expect(getMenuForRole("STORE_MANAGER", { wecom: true }).map((m) => m.key)).toContain("wecom-sidebar");
    expect(getMenuForRole("HQ", { wecom: true }).map((m) => m.key)).toContain("wecom");
    expect(getMenuForRole("STAFF").map((m) => m.key)).not.toContain("wecom-sidebar");
    expect(getMenuForRole("REGIONAL_MANAGER", { wecom: true }).map((m) => m.key)).not.toContain("wecom-sidebar");
    expect(getMenuForRole("STAFF", { wecom: true }).at(-1)?.key).toBe("roadmap");
  });
});
