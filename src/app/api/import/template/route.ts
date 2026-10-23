import type { NextRequest } from "next/server";
import { IMPORT_KIND_LABELS, isImportKind } from "@/lib/import/specs";
import { getCurrentUser } from "@/server/auth/current-user";
import { templateXlsx } from "@/server/import/templates";

// 下载导入模板（口径第 22 节）：.xlsx，第一张表填数据，第二张表是说明。只有总部。

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("请先登录", { status: 401 });
  if (user.mustChangePassword) return new Response("先改初始密码", { status: 403 });
  if (user.role !== "HQ") return new Response("没有权限", { status: 403 });
  const kind = request.nextUrl.searchParams.get("kind");
  if (!isImportKind(kind)) return new Response("参数不对", { status: 400 });
  const body = await templateXlsx(kind);
  const name = `导入模板-${IMPORT_KIND_LABELS[kind]}.xlsx`;
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="import-${kind.toLowerCase()}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    },
  });
}
