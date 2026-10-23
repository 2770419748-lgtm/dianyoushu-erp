import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/server/audit";

// 在服务器上重置某个账号的二次验证（口径第 20 节）：只有一个总部账号、它的手机又丢了时用（别人的在组织管理里点“重置二次验证”）。
// 用法：pnpm mfa:reset hq "手机丢了"
// 清掉绑定、所有已登录的设备下线，下次登录重新扫码绑定；操作日志记一笔（操作人为空 = 服务器上跑的）。

async function main() {
  const [username, reason] = process.argv.slice(2);
  if (!username || !reason?.trim()) {
    console.error('用法：pnpm mfa:reset <账号> "<原因>"');
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { username: username.trim().toLowerCase() }, select: { id: true, name: true, mfaSecretEnc: true } });
  if (!user) {
    console.error(`没有账号 ${username}`);
    process.exit(1);
  }
  if (!user.mfaSecretEnc) {
    console.log(`${user.name}（${username}）还没绑定二次验证，不用重置`);
    return;
  }
  await prisma.user.update({ where: { id: user.id }, data: { mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, sessionVersion: { increment: 1 } } });
  await writeAudit({ userId: null, action: "user.mfa_reset", entity: "user", entityId: user.id, detail: { reason: reason.trim().slice(0, 100), by: "服务器脚本" } });
  console.log(`已重置 ${user.name}（${username}）的二次验证：已登录的设备都下线了，下次登录重新扫码绑定`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
