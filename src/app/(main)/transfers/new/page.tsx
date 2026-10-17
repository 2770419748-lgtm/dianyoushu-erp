import { prisma } from "@/lib/prisma";
import { NoAccess } from "@/components/no-access";
import { requireUser } from "@/server/auth/current-user";
import { canManageTransfer } from "@/server/auth/permissions";
import { listStoresInScope } from "@/server/org/store-query";
import { listAccessoriesForTransfer, listDevicesForTransfer } from "@/server/transfer/transfer-service";
import { TransferForm } from "./transfer-form";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// 新建调拨：发出店只能选自己范围内的，收货店可以是任意营业中的门店。
export default async function NewTransferPage({ searchParams }: PageProps<"/transfers/new">) {
  const user = await requireUser();
  if (!canManageTransfer(user.role)) return <NoAccess />;
  const params = await searchParams;

  const [fromStores, allStores] = await Promise.all([
    listStoresInScope(user),
    prisma.store.findMany({ where: { isActive: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
  ]);
  if (fromStores.length === 0) return <NoAccess title="你没有可发出的门店" />;

  const requested = Number(one(params.fromStoreId));
  const fromStoreId = fromStores.some((s) => s.id === requested) ? requested : (user.storeId ?? fromStores[0]!.id);
  const [devices, accessories] = await Promise.all([listDevicesForTransfer(user, fromStoreId, { page: 1 }), listAccessoriesForTransfer(user, fromStoreId)]);

  return (
    // key：换发出门店时重建，机器列表和已勾选的都换成新门店的
    <TransferForm
      key={fromStoreId}
      fromStores={fromStores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))}
      toStores={allStores.map((s) => ({ id: s.id, label: `${s.code} ${s.name}` }))}
      fromStoreId={fromStoreId}
      devices={devices}
      accessories={accessories}
    />
  );
}
