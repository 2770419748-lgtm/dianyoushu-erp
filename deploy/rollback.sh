#!/usr/bin/env bash
# 手动回滚一家客户到上一个版本（口径第 24 节）：只换应用，不动数据库（迁移只加不删，旧版本能用新表结构）。
# 要回到升级前的数据，另外用升级前那份备份恢复（docs/部署.md 恢复演练）。
# 用法：deploy/rollback.sh <代号>
. "$(dirname "$0")/lib.sh"

CODE=${1:-}
[ -n "$CODE" ] || die "用法：deploy/rollback.sh <代号>"
require_tenant "$CODE"
CUR=$(current_tag "$CODE")
PREV=$(previous_tag "$CODE")
[ -n "$PREV" ] || die "$CODE 没有上一个版本可回"
release_exists "$PREV" || die "上一个版本 $PREV 的镜像不在了（被清理了？）：先 git checkout 它再 deploy/build.sh"
DIR=$(tenant_dir "$CODE")
log "回滚 $CODE：$CUR → $PREV"
echo "$PREV" > "$DIR/.deploy/current"
echo "$CUR" > "$DIR/.deploy/previous"
dc "$CODE" up -d --no-build app backup
if wait_healthy "$CODE" 120; then
  record "$CODE" "回滚 $CUR → $PREV 成功"
  log "$CODE 回滚到 $PREV 完成"
else
  record "$CODE" "回滚 $CUR → $PREV 以后不健康"
  alert "$CODE 回滚到 $PREV 以后健康检查不过，马上看：docker compose -p erp-$CODE logs app"
  exit 1
fi
