import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { requireUser, type CurrentUser } from "@/server/auth/current-user";
import { PermissionError } from "@/server/auth/scope";
import { getDeviceByImei, type DeviceDetail } from "@/server/stock/stock-query";
import { DeviceView } from "./device-view";

export const dynamic = "force-dynamic";

type Loaded = { kind: "ok"; device: DeviceDetail } | { kind: "forbidden" } | { kind: "missing" };

async function load(user: CurrentUser, imei: string): Promise<Loaded> {
  try {
    const device = await getDeviceByImei(user, imei);
    return device ? { kind: "ok", device } : { kind: "missing" };
  } catch (error) {
    if (error instanceof PermissionError) return { kind: "forbidden" };
    throw error;
  }
}

// 串号详情：这台机器从入库到现在的全程流水。
export default async function DevicePage({ params }: PageProps<"/stock/devices/[imei]">) {
  const { imei } = await params;
  if (!/^\d{15}$/.test(imei)) notFound();
  const user = await requireUser();
  const loaded = await load(user, imei);
  if (loaded.kind === "missing") notFound();
  if (loaded.kind === "forbidden") return <NoAccess title="没有权限看这台机器" />;
  return <DeviceView device={loaded.device} showCost={user.role !== "STAFF"} />;
}
