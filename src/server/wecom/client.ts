import "server-only";
import { prisma } from "@/lib/prisma";
import { asTx, type Db, withTx } from "@/server/db-tx";

export { asTx, withTx };
export type { Db };
import { wecomMode } from "./config";

// 企业微信接口封装（口径第 12 节）。业务代码只认 WecomClient 这个接口，有两种实现：
// - 真实现：只用一个自建应用 Secret 换 access_token（2023-12-01 起新企业不能再用系统应用的 Secret），令牌落库缓存，
//   过期前 5 分钟刷新，刷新时用事务级咨询锁排队，同一时间只有一个请求真去换令牌；错误码翻成人话。
// - 模拟实现：演示用，不连网，返回假数据。测试里也可以传自己的替身。

export class WecomError extends Error {
  constructor(
    message: string,
    readonly errcode?: number,
  ) {
    super(message);
    this.name = "WecomError";
  }
}

export interface WecomClient {
  readonly mode: "real" | "simulated";
  /** 通讯录：这个 userid 是不是本企业成员 */
  getMember(userid: string): Promise<{ userid: string; name: string }>;
  /** 建一个只给某个员工的“联系我”二维码，state 带开单绑定码 */
  createOrderContactWay(input: { userid: string; state: string; remark: string }): Promise<{ configId: string; qrCodeUrl: string | null }>;
  deleteContactWay(configId: string): Promise<void>;
  /** 外部联系人的微信昵称、头像（拿不到手机号，企业微信不给） */
  getExternalContact(externalUserid: string): Promise<{ name: string; avatar: string | null }>;
  /** 加好友事件里的 welcome_code 只能在 20 秒内用一次 */
  sendWelcomeMessage(welcomeCode: string, text: string): Promise<void>;
}

// ---------- 错误码 ----------

const ERRCODE_TEXT: Record<number, string> = {
  [-1]: "企业微信系统繁忙，稍后再试",
  40001: "应用 Secret 不对，检查 WECOM_APP_SECRET",
  40013: "企业 ID 不对，检查 WECOM_CORP_ID",
  40014: "访问令牌无效",
  41001: "缺少访问令牌",
  42001: "访问令牌过期了",
  45009: "调接口太频繁，稍后再试",
  48002: "这个应用没有调这个接口的权限：在企业微信后台把它设为客户联系的“可调用接口的应用”",
  60011: "这个应用看不到这个成员：在企业微信后台把成员加进应用的可见范围",
  60020: "服务器 IP 不在企业可信 IP 里：在企业微信后台的应用里配置企业可信 IP",
  60111: "企业微信里没有这个账号（userid），检查拼写",
  84061: "这个客户和员工之间没有好友关系",
};

export function translateWecomError(errcode: number, errmsg: string): string {
  const text = ERRCODE_TEXT[errcode];
  return text ? `${text}（错误码 ${errcode}）` : `企业微信接口报错（错误码 ${errcode}：${errmsg}）`;
}

/** 令牌失效、要重新换的错误码 */
const TOKEN_ERRCODES = new Set([40014, 41001, 42001]);

// ---------- 令牌缓存 ----------

export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const TOKEN_CACHE_KEY = "app";
const TOKEN_LOCK_KEY = 7311001; // 咨询锁的键（单个 bigint，和门店日结用的两个 int 的锁不在一个键空间）

export function tokenNeedsRefresh(expiresAt: Date | null | undefined, now: Date): boolean {
  return !expiresAt || expiresAt.getTime() - now.getTime() <= TOKEN_REFRESH_MARGIN_MS;
}

// ---------- 真实现 ----------

export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

const BASE = "https://qyapi.weixin.qq.com/cgi-bin";

type WecomJson = { errcode?: number; errmsg?: string } & Record<string, unknown>;

export function createRealWecomClient(options: { corpId: string; secret: string; transport?: Transport; db?: Db; now?: () => Date }): WecomClient {
  const transport = options.transport ?? ((url, init) => fetch(url, init));
  const db = options.db ?? prisma;
  const now = options.now ?? (() => new Date());

  async function fetchJson(url: string, init?: RequestInit): Promise<WecomJson> {
    let res: Response;
    try {
      res = await transport(url, { ...init, signal: AbortSignal.timeout(8000) });
    } catch {
      throw new WecomError("连不上企业微信接口（网络或超时）");
    }
    if (!res.ok) throw new WecomError(`企业微信接口返回 HTTP ${res.status}`);
    return (await res.json()) as WecomJson;
  }

  async function fetchToken(): Promise<{ token: string; expiresAt: Date }> {
    const data = await fetchJson(`${BASE}/gettoken?corpid=${encodeURIComponent(options.corpId)}&corpsecret=${encodeURIComponent(options.secret)}`);
    if (data.errcode) throw new WecomError(translateWecomError(data.errcode, data.errmsg ?? ""), data.errcode);
    const seconds = Number(data.expires_in) || 7200;
    return { token: String(data.access_token), expiresAt: new Date(now().getTime() + seconds * 1000) };
  }

  /** 读缓存；快过期或者 stale（刚被企业微信判无效的那个）就排队刷新 */
  async function getToken(stale?: string): Promise<string> {
    const cached = await db.wecomTokenCache.findUnique({ where: { key: TOKEN_CACHE_KEY } });
    if (cached && cached.token !== stale && !tokenNeedsRefresh(cached.expiresAt, now())) return cached.token;
    return withTx(db, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TOKEN_LOCK_KEY}::bigint)`;
      const again = await tx.wecomTokenCache.findUnique({ where: { key: TOKEN_CACHE_KEY } });
      if (again && again.token !== stale && !tokenNeedsRefresh(again.expiresAt, now())) return again.token; // 排队时别人已经刷新好了
      const fresh = await fetchToken();
      await tx.wecomTokenCache.upsert({ where: { key: TOKEN_CACHE_KEY }, create: { key: TOKEN_CACHE_KEY, ...fresh }, update: fresh });
      return fresh.token;
    });
  }

  async function call(path: string, init: { method?: "GET" | "POST"; query?: Record<string, string>; body?: unknown } = {}): Promise<WecomJson> {
    let token = await getToken();
    for (let attempt = 0; ; attempt++) {
      const qs = new URLSearchParams({ access_token: token, ...init.query });
      const data = await fetchJson(`${BASE}${path}?${qs}`, init.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init.body ?? {}) } : undefined);
      if (!data.errcode) return data;
      if (TOKEN_ERRCODES.has(data.errcode) && attempt === 0) {
        token = await getToken(token); // 令牌被判无效：换一个再试一次
        continue;
      }
      throw new WecomError(translateWecomError(data.errcode, data.errmsg ?? ""), data.errcode);
    }
  }

  return {
    mode: "real",
    async getMember(userid) {
      const data = await call("/user/get", { query: { userid } });
      return { userid: String(data.userid ?? userid), name: String(data.name ?? "") };
    },
    async createOrderContactWay(input) {
      const data = await call("/externalcontact/add_contact_way", {
        method: "POST",
        body: { type: 1, scene: 2, user: [input.userid], state: input.state, remark: input.remark.slice(0, 30), skip_verify: true },
      });
      return { configId: String(data.config_id), qrCodeUrl: typeof data.qr_code === "string" ? data.qr_code : null };
    },
    async deleteContactWay(configId) {
      await call("/externalcontact/del_contact_way", { method: "POST", body: { config_id: configId } });
    },
    async getExternalContact(externalUserid) {
      const data = await call("/externalcontact/get", { query: { external_userid: externalUserid } });
      const contact = (data.external_contact ?? {}) as { name?: string; avatar?: string };
      return { name: contact.name ?? "", avatar: contact.avatar ?? null };
    },
    async sendWelcomeMessage(welcomeCode, text) {
      await call("/externalcontact/send_welcome_msg", { method: "POST", body: { welcome_code: welcomeCode, text: { content: text } } });
    },
  };
}

// ---------- 模拟实现 ----------

/** 模拟模式的微信昵称：按外部联系人 id 固定生成，同一个人每次一样 */
export function simulatedNickname(externalUserid: string): string {
  return `微信用户${externalUserid.slice(-4).toUpperCase()}`;
}

export function createSimulatedWecomClient(): WecomClient {
  return {
    mode: "simulated",
    async getMember(userid) {
      return { userid, name: "" }; // 模拟模式没法核对，页面上会说明
    },
    async createOrderContactWay(input) {
      return { configId: `sim-${input.state}`, qrCodeUrl: null }; // 没有真二维码，页面画占位图
    },
    async deleteContactWay() {},
    async getExternalContact(externalUserid) {
      return { name: simulatedNickname(externalUserid), avatar: null };
    },
    async sendWelcomeMessage() {},
  };
}

// ---------- 按模式取 ----------

let override: WecomClient | null = null;
let realClient: WecomClient | null = null;

/** 测试里换成替身；传 null 恢复 */
export function setWecomClientForTests(client: WecomClient | null): void {
  override = client;
}

export function getWecomClient(): WecomClient {
  if (override) return override;
  const mode = wecomMode();
  if (mode === "off") throw new WecomError("企业微信对接没有打开");
  if (mode === "simulated") return createSimulatedWecomClient();
  realClient ??= createRealWecomClient({ corpId: process.env.WECOM_CORP_ID ?? "", secret: process.env.WECOM_APP_SECRET ?? "" });
  return realClient;
}
