#!/usr/bin/env bash
# 手动回滚一家客户到上一个版本（口径第 24 节）：只换应用，不动数据库。
# 前提是这期间做的迁移都是“只加不删”；做过标了“不能直接回滚”的迁移（prisma/migrations-not-rollback-safe.txt：删列、改名、
# 枚举加值……）就拒绝——旧版本读不了这些数据，回去了日结、看板会打不开。这时只能修好新版本，或者用升级前的备份恢复（docs/部署.md 恢复演练）。
# 回滚以后用旧版本把主要业务表读一遍（对账），读不了就告警。
# 用法：deploy/rollback.sh <代号>
. "$(dirname "$0")/lib.sh"

CODE=${1:-}
[ -n "$CODE" ] || die "用法：deploy/rollback.sh <代号>"
require_tenant "$CODE"
CUR=$(current_tag "$CODE")
PREV=$(previous_tag "$CODE")
[ -n "$PREV" ] || die "$CODE 没有上一个版本可回"
release_exists "$PREV" || die "上一个版本 $PREV 的镜像不在了（被清理了？）：先 git checkout 它再 deploy/build.sh"
BLOCKERS=$(irreversible_since "$CODE" "$PREV" "$CUR")
if [ -n "$BLOCKERS" ]; then
  record "$CODE" "回滚 $CUR → $PREV 拒绝：做过不能直接回滚的迁移"
  die "$CODE 不能直接回滚到 $PREV：库里做过这些 $PREV 没有、而且不能直接回滚的迁移——
$BLOCKERS
旧版本读不了这些改动以后的数据。只能修好 $CUR，或者用升级前的备份恢复（升级以后录的数据会丢）"
fi
DIR=$(tenant_dir "$CODE")
log "回滚 $CODE：$CUR → $PREV"
echo "$PREV" > "$DIR/.deploy/current"
echo "$CUR" > "$DIR/.deploy/previous"
dc "$CODE" up -d --no-build app backup
if ! wait_healthy "$CODE" 120; then
  record "$CODE" "回滚 $CUR → $PREV 以后不健康"
  alert "$CODE 回滚到 $PREV 以后健康检查不过，马上看：docker compose -p erp-$CODE logs app"
  exit 1
fi
if ! read_check "$CODE"; then
  record "$CODE" "回滚 $CUR → $PREV 以后读数据出错"
  alert "$CODE 回滚到 $PREV 以后用旧版本读数据出错（对账跑不过），马上看：deploy/dc.sh $CODE run --rm tools pnpm db:check"
  exit 1
fi
record "$CODE" "回滚 $CUR → $PREV 成功"
log "$CODE 回滚到 $PREV 完成"
