// 企业微信对接的开关和配置（口径第 12 节）。纯函数，读环境变量，测试里可以传自己的 env。
//
// 三种模式：
// - real（真对接）：WECOM_ENABLED=1，真调企业微信接口，回调地址打开。要在企业微信后台配好自建应用、可信 IP、回调地址。
// - simulated（模拟）：没开真对接、但在演示模式（DEMO_MODE 不是 0）。不连企业微信，接口换成模拟实现，
//   页面上有“模拟扫码加好友”，造一条加密事件走一遍真实的回调处理（验签、解密、去重、绑定、写日志）。
// - off（关）：真给门店用（DEMO_MODE=0）又没开企业微信，整个模块不显示。
// 是否真调企业微信只看 WECOM_ENABLED，和 DEMO_MODE 分开：演示站也能开真对接，联调时不用关演示模式。

export type WecomMode = "real" | "simulated" | "off";

type Env = Record<string, string | undefined>;

export function wecomMode(env: Env = process.env): WecomMode {
  if (env.WECOM_ENABLED === "1") return "real";
  return env.DEMO_MODE === "0" ? "off" : "simulated";
}

/** 回调的验签和加解密配置：Token、EncodingAESKey、企业 ID（解密后核对的 receiveid） */
export interface CallbackConfig {
  token: string;
  aesKey: string;
  receiveId: string;
}

/**
 * 模拟模式专用的回调配置。不是密钥：只给演示里自己造的事件加解密用，模拟模式下真回调地址是关着的（404），
 * 所以写在代码里、公开出去也没关系。真对接用 .env 里的 WECOM_CALLBACK_TOKEN / WECOM_CALLBACK_AES_KEY。
 */
export const SIMULATED_CALLBACK: CallbackConfig = {
  token: "dianyoushuSimulated",
  aesKey: "ZGlhbnlvdXNodS1lcnAtc2ltdWxhdGVkLWtleS0zMmI", // = base64("dianyoushu-erp-simulated-key-32b") 去掉末尾的 =
  receiveId: "ww-simulated-corp",
};

export function realCallbackConfig(env: Env = process.env): CallbackConfig {
  return { token: env.WECOM_CALLBACK_TOKEN ?? "", aesKey: env.WECOM_CALLBACK_AES_KEY ?? "", receiveId: env.WECOM_CORP_ID ?? "" };
}

/** 真对接必须有的配置（只用一个自建应用 Secret：2023-12-01 起新企业不能再用系统应用的 Secret 调接口） */
export const WECOM_REQUIRED_ENV = ["WECOM_CORP_ID", "WECOM_APP_SECRET", "WECOM_AGENT_ID", "WECOM_CALLBACK_TOKEN", "WECOM_CALLBACK_AES_KEY"] as const;

/** 开单绑定码多久过期 */
export const BIND_CODE_DAYS = 30;

/** 回调请求的时间戳和服务器时间差超过 5 分钟就拒收（防止有人把抓到的请求再发一遍） */
export const CALLBACK_MAX_SKEW_SECONDS = 300;

/** 企业微信 userid 的格式：1～64 位字母、数字和 _ - . @ */
export const WECOM_USERID_PATTERN = /^[A-Za-z0-9_.@-]{1,64}$/;
