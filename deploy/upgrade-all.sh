#!/usr/bin/env bash
# 把所有客户升级到某个版本（口径第 24 节）：演示站（代号 demo）要先在这个版本上跑满 20 小时；
# 客户按代号顺序一家一家升，一家失败就停下，后面的不升（坏版本不扩散）。
# 用法：deploy/upgrade-all.sh <版本> [--force] [--skip-demo-check]
#   --force：白天也发；--skip-demo-check：不等演示站（紧急修复时）
. "$(dirname "$0")/lib.sh"

TAG=${1:-}
[ -n "$TAG" ] || die "用法：deploy/upgrade-all.sh <版本> [--force] [--skip-demo-check]"
shift
FORCE=""
SKIP_DEMO=""
for a in "$@"; do
  case "$a" in
    --force) FORCE=--force ;;
    --skip-demo-check) SKIP_DEMO=1 ;;
    *) die "不认识的参数：$a" ;;
  esac
done
check_window "$FORCE"

if [ -z "$SKIP_DEMO" ] && [ -f "$(tenant_dir demo)/.env" ]; then
  [ "$(current_tag demo)" = "$TAG" ] || die "演示站还不是 $TAG：先 deploy/deploy.sh demo $TAG，跑一天没问题再升客户"
  since=$(grep "升级 .* → $TAG 成功" "$(tenant_dir demo)/.deploy/history.log" | tail -1 | cut -c1-19)
  [ -n "$since" ] || die "找不到演示站升级到 $TAG 的记录"
  hours=$((($(date +%s) - $(date -d "$since" +%s)) / 3600))
  [ "$hours" -ge 20 ] || die "演示站升级到 $TAG 才 $hours 小时，跑满 20 小时再升客户（紧急修复加 --skip-demo-check）"
fi

done_list=()
for t in $(list_tenants); do
  [ "$t" = demo ] && continue
  if [ "$(current_tag "$t")" = "$TAG" ]; then
    log "$t 已经是 $TAG"
    continue
  fi
  if ! "$(dirname "$0")/deploy.sh" "$t" "$TAG" --force; then
    alert "批量升级到 $TAG 在 $t 停下了（已升好：${done_list[*]:-无}）；后面的客户没升"
    exit 1
  fi
  done_list+=("$t")
done
log "批量升级到 $TAG 完成：${done_list[*]:-没有要升的}"
