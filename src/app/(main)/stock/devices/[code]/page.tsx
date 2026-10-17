import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { requireUser, type CurrentUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { docLinks } from "@/server/stock/doc-links";
import { isValidCode } from "@/server/stock/imei";
import { getDeviceByCode, type DeviceDetail } from "@/server/stock/stock-query";
import { DeviceView } from "./device-view";

export const dynamic = "force-dynamic";

type Loaded = { kind: "ok"; device: DeviceDetail } | { kind: "forbidden" } | { kind: "missing" };

async function load(user: CurrentUser, code: string): Promise<Loaded> {
  try {
    const device = await getDeviceByCode(user, code);
    return device ? { kind: "ok", device } : { kind: "missing" };
  } catch (error) {
    if (error instanceof PermissionError) return { kind: "forbidden" };
    throw error;
  }
}

// 机器详情：地址里的码可以是主码、SN、IMEI1、IMEI2 任意一个（扫码跳转也走这里）。
export default async function DevicePage({ params }: PageProps<"/stock/devices/[code]">) {
  const { code } = await params;
  const decoded = decodeURIComponent(code);
  if (!isValidCode(decoded)) notFound();
  const user = await requireUser();
  const loaded = await load(user, decoded);
  if (loaded.kind === "missing") notFound();
  if (loaded.kind === "forbidden") return <NoAccess title="没有权限看这台机器" />;
  const links = await docLinks(loaded.device.ledgers.map((l) => l.docNo));
  return <DeviceView device={loaded.device} links={links} showCost={user.role !== "STAFF"} />;
}
