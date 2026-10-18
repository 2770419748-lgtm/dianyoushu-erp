import "server-only";
import { prisma } from "@/lib/prisma";
import type { SessionPayload } from "./token";

// 由登录令牌找到当前用户：账号要存在、在职，而且令牌里的会话版本号要和库里一致。
// 改密码（自己改或总部重置）、停用 / 启用时库里的版本号会 +1，之前签发的令牌就对不上了，等于立刻下线；
// 不然被盗的 cookie 在 7 天过期前一直能用。
export async function findSessionUser(session: SessionPayload) {
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      username: true,
      name: true,
      role: true,
      storeId: true,
      regionId: true,
      isActive: true,
      sessionVersion: true,
      store: { select: { id: true, name: true, regionId: true } },
      region: { select: { id: true, name: true } },
    },
  });
  if (!user || !user.isActive || user.sessionVersion !== session.sv) return null;
  const { sessionVersion: _version, ...rest } = user;
  void _version;
  return rest;
}
