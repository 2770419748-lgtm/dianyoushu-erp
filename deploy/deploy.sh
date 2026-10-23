#!/usr/bin/env bash
# 升级一家客户到某个版本（口径第 24 节），健康检查不过自动回滚：
#   1 先备份一份（备份失败不升级）→ 2 用新版本跑数据库迁移 → 3 换新版本的应用 → 4 等健康检查（最多 2 分钟）
#   → 不过就换回上一个版本、告警 → 5 过了再对一遍账（对不上告警，不回滚，人工看）。
# 迁移“只加不删”时回滚应用不用回滚数据库；新版本里有标了“不能直接回滚”的迁移（prisma/migrations-not-rollback-safe.txt：
# 删列、改名……）时，做完迁移就回不去了：升级前会提示，健康检查不过也不自动回滚，只能修好新版本或者用第 1 步的备份恢复。
# 只加了枚举值的（清单里原因写“枚举加值”开头）例外：新版本没健康过、库里还没用到新值，照样自动回滚（复查第 92 条）。
# 用法：deploy/deploy.sh <代号> <版本> [--force]    （--force：白天也发）
. "$(dirname "$0")/lib.sh"

CODE=${1:-}
TAG=${2:-}
FORCE=${3:-}
[ -n "$CODE" ] && [ -n "$TAG" ] || die "用法：deploy/deploy.sh <代号> <版本> [--force]"
require_tenant "$CODE"
check_window "$FORCE"
release_exists "$TAG" || die "没有版本 $TAG 的镜像，先 deploy/build.sh"
OLD=$(current_tag "$CODE")
[ "$OLD" = "$TAG" ] && {
  log "$CODE 已经是 $TAG，不用升级"
  exit 0
}
DIR=$(tenant_dir "$CODE")
log "升级 $CODE：$OLD → $TAG"
# 这次要做的迁移里有没有“不能直接回滚”的：有就先说清楚，记进发布记录
PENDING_IRREVERSIBLE=$(
  applied=$(applied_migrations "$CODE")
  list=$(docker run --rm "$TOOLS_REPO:$TAG" cat prisma/migrations-not-rollback-safe.txt 2> /dev/null || true)
  for m in $(release_migrations "$TAG"); do
    grep -qx "$m" <<< "$applied" && continue
    grep -E "^$m( |$)" <<< "$list" || true
  done
)
if [ -n "$PENDING_IRREVERSIBLE" ]; then
  warn "这次升级有不能直接回滚的迁移（“枚举加值”的在库里用上新值之前还能回滚，别的升级以后要回到 $OLD 只能用升级前的备份恢复）：
$PENDING_IRREVERSIBLE"
  record "$CODE" "升级 $OLD → $TAG 含不能直接回滚的迁移：$(echo "$PENDING_IRREVERSIBLE" | cut -d' ' -f1 | tr '\n' ' ')"
fi

log "1/5 备份"
if ! dc "$CODE" exec -T backup bash /backup.sh now; then
  record "$CODE" "升级 $OLD → $TAG 没做：备份失败"
  alert "$CODE 升级到 $TAG 没做：升级前备份失败"
  exit 1
fi

log "2/5 数据库迁移（用 $TAG）"
if ! DC_TAG="$TAG" dc "$CODE" run --rm -T tools pnpm exec prisma migrate deploy; then
  # 应用还是旧版本在跑；迁移只加不删，旧版本照样能用。迁移失败一半要人工看，必要时用刚才的备份恢复
  record "$CODE" "升级 $OLD → $TAG 失败：迁移出错，应用还是 $OLD"
  alert "$CODE 升级到 $TAG 迁移出错，应用还在 $OLD 上跑；看 docker compose -p erp-$CODE 的输出，必要时用升级前的备份恢复"
  exit 1
fi

log "3/5 换新版本"
echo "$OLD" > "$DIR/.deploy/previous"
echo "$TAG" > "$DIR/.deploy/current"
dc "$CODE" up -d --no-build app backup

log "4/5 等健康检查"
if ! wait_healthy "$CODE" 120; then
  BLOCKERS=$(irreversible_since "$CODE" "$OLD" "$TAG")
  if [ -n "$BLOCKERS" ]; then
    record "$CODE" "升级 $OLD → $TAG 失败：健康检查不过，迁移不能直接回滚，没回滚"
    alert "$CODE 升级到 $TAG 健康检查不过，而且做过不能直接回滚的迁移（$(echo "$BLOCKERS" | cut -d' ' -f1 | tr '\n' ' ')），没有自动回滚：修好新版本，或者用升级前的备份恢复"
    exit 1
  fi
  warn "$CODE 的 $TAG 健康检查不过，回滚到 $OLD"
  echo "$OLD" > "$DIR/.deploy/current"
  echo "$TAG" > "$DIR/.deploy/previous"
  dc "$CODE" up -d --no-build app backup
  if wait_healthy "$CODE" 120; then
    record "$CODE" "升级 $OLD → $TAG 失败：健康检查不过，已回滚到 $OLD"
    alert "$CODE 升级到 $TAG 健康检查不过，已自动回滚到 $OLD"
    read_check "$CODE" || alert "$CODE 回滚到 $OLD 以后用旧版本读数据出错（对账跑不过），马上看"
  else
    record "$CODE" "升级 $OLD → $TAG 失败：健康检查不过，回滚到 $OLD 以后也不健康"
    alert "$CODE 升级到 $TAG 失败，回滚到 $OLD 以后也不健康，马上看：docker compose -p erp-$CODE logs app"
  fi
  exit 1
fi

log "5/5 对账"
if ! dc "$CODE" run --rm -T tools pnpm -s db:check; then
  alert "$CODE 升级到 $TAG 以后对账不过（没回滚），人工看 pnpm db:check 的输出"
fi
record "$CODE" "升级 $OLD → $TAG 成功"
log "$CODE 升级到 $TAG 完成"
