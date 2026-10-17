// 本机临时 HTTPS：让同一个 Wi-Fi 下的手机能打开开发版并调用摄像头扫码。
// 浏览器只在 HTTPS（或 localhost）页面里给摄像头，手机访问电脑只能走局域网 IP，所以要 HTTPS。
//
// 做法：用 openssl 给"本机局域网 IP"签一张自签名证书（不装根证书、不改系统设置），
// 再用这张证书启动 next dev。手机第一次打开会提示"不安全"，点"高级 → 继续访问"即可。
// 证书放在用户目录 ~/.dianyoushu-erp/dev-certs，不进代码仓库；IP 变了会自动重签。
//
// 用法：pnpm dev:https            （自动找局域网 IP）
//       pnpm dev:https 192.168.1.8 （手动指定 IP）
// 注意：和 pnpm dev 二选一，同一个项目同时只能跑一个开发服务器。

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";

const PORT = process.env.PORT ?? "3000";

function findLanIp() {
  const candidates = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === "IPv4" && !addr.internal) candidates.push(addr.address);
    }
  }
  // 家用路由器常见网段优先，其次 10.x、172.16-31.x
  const score = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return candidates.sort((a, b) => score(a) - score(b))[0];
}

function findOpenssl() {
  const options = ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe"];
  return options.find((cmd) => spawnSync(cmd, ["version"], { stdio: "ignore" }).status === 0);
}

const ip = process.argv[2] ?? findLanIp();
if (!ip) {
  console.error("没找到局域网 IP：确认电脑连着 Wi-Fi 或网线，或者手动传 IP，例如 pnpm dev:https 192.168.1.8");
  process.exit(1);
}

const dir = join(homedir(), ".dianyoushu-erp", "dev-certs");
const keyFile = join(dir, "key.pem");
const certFile = join(dir, "cert.pem");
const ipFile = join(dir, "ip.txt");
mkdirSync(dir, { recursive: true });

const certOk = existsSync(keyFile) && existsSync(certFile) && existsSync(ipFile) && readFileSync(ipFile, "utf8").trim() === ip;
if (!certOk) {
  const openssl = findOpenssl();
  if (!openssl) {
    console.error("没找到 openssl。装了 Git for Windows 的话它自带一个；或者把 openssl 加进 PATH 后再试。");
    process.exit(1);
  }
  console.log(`给 ${ip} 签一张本机测试证书（有效期 1 年）…`);
  const result = spawnSync(
    openssl,
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "365",
      "-keyout", keyFile, "-out", certFile,
      "-subj", "/CN=dianyoushu-erp-local-dev",
      "-addext", `subjectAltName=IP:${ip},IP:127.0.0.1,DNS:localhost`,
      "-addext", "extendedKeyUsage=serverAuth",
      "-addext", "keyUsage=digitalSignature,keyEncipherment",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  writeFileSync(ipFile, ip);
}

console.log("");
console.log("==============================================");
console.log(` 手机连同一个 Wi-Fi，浏览器打开：https://${ip}:${PORT}`);
console.log(" 提示“不安全 / 证书无效”时点“高级 → 继续访问”。");
console.log(" Windows 第一次会弹防火墙提示，选“允许”（专用网络）。");
console.log("==============================================");
console.log("");

const child = spawn(
  "pnpm",
  ["exec", "next", "dev", "-H", ip, "-p", PORT, "--experimental-https", "--experimental-https-key", `"${keyFile}"`, "--experimental-https-cert", `"${certFile}"`],
  { stdio: "inherit", shell: true },
);
child.on("exit", (code) => process.exit(code ?? 0));
