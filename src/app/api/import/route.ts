import { NextResponse } from "next/server";
import { isWritable } from "@/lib/license";
import { isImportKind } from "@/lib/import/specs";
import { isSameOrigin } from "@/lib/same-origin";
import { getCurrentUser } from "@/server/auth/current-user";
import { commitImport, ImportError, precheckImport } from "@/server/import/import-service";
import { MAX_UPLOAD_BYTES } from "@/server/import/read-file";
import { currentLicenseState } from "@/server/license/license-service";

// 数据导入（口径第 22 节）：上传文件预检、确认导入。用接口而不是 Server Function：文件可能有几 MB，
// Server Function 的请求体上限是全站一起放大的，只给这一个接口放到 5 MB。
// 只认本站发的 POST；只有总部；到期只读、还没改初始密码时不让导。

export async function POST(request: Request) {
  if (!isSameOrigin(request.headers)) return NextResponse.json({ error: "来源不对" }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (user.role !== "HQ") return NextResponse.json({ error: "只有总部能导入数据" }, { status: 403 });
  if (user.mustChangePassword) return NextResponse.json({ error: "先改初始密码" }, { status: 403 });
  if (!isWritable(await currentLicenseState())) return NextResponse.json({ error: "服务已到期，只能查看和导出" }, { status: 403 });
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_UPLOAD_BYTES + 64 * 1024) return NextResponse.json({ error: `文件太大了（最大 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB），分成几个文件导` }, { status: 413 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "没收到文件" }, { status: 400 });
  }
  const kind = form.get("kind");
  const mode = form.get("mode");
  const file = form.get("file");
  if (!isImportKind(kind) || (mode !== "check" && mode !== "commit") || !(file instanceof File)) return NextResponse.json({ error: "参数不对" }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: `文件太大了（最大 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB），分成几个文件导` }, { status: 413 });
  const upload = { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name };
  try {
    if (mode === "check") return NextResponse.json({ check: await precheckImport(user, kind, upload) });
    const result = await commitImport(user, kind, upload, { legalConfirmed: form.get("legal") === "1" });
    return NextResponse.json(result.ok ? { done: result.done } : { check: result.check });
  } catch (error) {
    if (error instanceof ImportError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: "导入失败，请稍后再试" }, { status: 500 });
  }
}
