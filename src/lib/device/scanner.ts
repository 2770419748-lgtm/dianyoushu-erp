// 扫码能力的统一接口（AGENTS.md「保留升级成 App 的路径」第 3 条）。
// 网页版用 html5-qrcode 调浏览器摄像头；以后打包成 App 时，换一个用原生扫码插件的实现，调用方不改。
// 只能在浏览器里用（客户端组件），而且页面必须是 HTTPS 或 localhost，否则浏览器不给摄像头。

export interface ScannerHandle {
  stop: () => Promise<void>;
}

export type ScanErrorKind = "insecure" | "denied" | "no-camera" | "unknown";

export class ScanError extends Error {
  constructor(
    public kind: ScanErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** 当前页面能不能用摄像头（HTTPS 或 localhost） */
export function canUseCamera(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * 在 elementId 这个容器里打开后置摄像头扫码；扫到一个码就回调一次（同一个码 2 秒内不重复回调）。
 * 支持手机串号常用的 Code128、商品条码 EAN-13 / EAN-8 / UPC，以及二维码。
 */
export async function startScanner(elementId: string, onCode: (code: string) => void): Promise<ScannerHandle> {
  if (!canUseCamera()) throw new ScanError("insecure", "要用 HTTPS 打开网页才能调摄像头（手机测试见 README“手机上测试”）");
  const { Html5Qrcode, Html5QrcodeSupportedFormats: F } = await import("html5-qrcode");
  const scanner = new Html5Qrcode(elementId, {
    verbose: false,
    formatsToSupport: [F.CODE_128, F.CODE_39, F.EAN_13, F.EAN_8, F.UPC_A, F.QR_CODE],
  });
  let last = "";
  let lastAt = 0;
  try {
    await scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: (w: number, h: number) => ({ width: Math.floor(w * 0.85), height: Math.floor(Math.min(h, w) * 0.4) }) },
      (text) => {
        const code = text.trim();
        const now = Date.now();
        if (code === last && now - lastAt < 2000) return;
        last = code;
        lastAt = now;
        onCode(code);
      },
      undefined,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Permission|NotAllowed/i.test(message)) throw new ScanError("denied", "摄像头权限被拒绝了，在浏览器设置里允许后再试");
    if (/NotFound|Requested device not found/i.test(message)) throw new ScanError("no-camera", "没找到摄像头");
    throw new ScanError("unknown", `打开摄像头失败：${message}`);
  }
  return {
    stop: async () => {
      try {
        if (scanner.isScanning) await scanner.stop();
        scanner.clear();
      } catch {
        // 已经停了就算了
      }
    },
  };
}

/** 扫到的码追加到多行文本框末尾（一行一个）；已经在里面的不重复加 */
export function appendScannedCode(text: string | undefined, code: string): string {
  const current = (text ?? "").replace(/\s+$/, "");
  const exists = current.split(/[\s,，;；]+/).includes(code);
  if (exists) return text ?? "";
  return current ? `${current}\n${code}` : code;
}
