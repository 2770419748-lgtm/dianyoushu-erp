#!/usr/bin/env bash
# 把下线了（没加 --purge、库卷还留着）的客户原样起回来（口径第 24 节，复查第 93、94 条）：老客户回来续费时用，不要用 tenant-new.sh 重开
# （新 .env 的密码连不上老库，开户会失败）。
# $ERP_ROOT/removed/ 里这家最新的那份目录挪回 tenants/ → 用原来的 .env 和版本接上留着的库卷 → 起应用和备份 →
# 马上备份一份、对一遍账（对不上就停，不加站点）→ 定时任务的成功时间从现在算 → 共享 Caddy 加回原来的站点地址。
# 中途失败（目录已经挪回来了）：改好以后再跑一次同样的命令，接着做。
# 到期了的起回来以后续费：deploy/dc.sh <代号> run --rm tools pnpm license:set --days 365
# 用法：deploy/tenant-restore.sh <代号>
. "$(dirname "$0")/lib.sh"

CODE=${1:-}
valid_code "$CODE" || die "用法：deploy/tenant-restore.sh <代号>"
DIR=$(tenant_dir "$CODE")
# 起了一半的标记：目录挪回来时建、全做完删；有它说明上次中途失败，这次接着做
MARK="$DIR/.deploy/restoring"
if [ -e "$DIR" ]; then
  [ -f "$MARK" ] || die "已经有 $CODE 了：$DIR"
  log "$CODE 上次起回来没做完，接着做"
  [ -n "$(tenant_volumes "$CODE")" ] || die "$CODE 的库卷不在了，起不回来：看 $DIR/backups 里的备份（docs/部署.md“恢复演练”）"
  TAG=$(current_tag "$CODE")
  SITE=$(tenant_site "$CODE")
else
  # 下线时挪去的目录叫 <代号>-<日期>-<时间>；按名字精确匹配，代号是 t2 时不会挑到 t2-shop 的
  NAME=$(ls -1 "$ERP_ROOT/removed" 2> /dev/null | grep -E "^$CODE-[0-9]{8}-[0-9]{6}$" | sort | tail -1 || true)
  [ -n "$NAME" ] && [ -f "$ERP_ROOT/removed/$NAME/.env" ] || die "$ERP_ROOT/removed/ 里没有 $CODE 下线留下的目录"
  SRC="$ERP_ROOT/removed/$NAME"
  [ -n "$(tenant_volumes "$CODE")" ] || die "$CODE 的库卷不在了（下线时加了 --purge）：只能另开户以后用 $SRC/backups 里的备份恢复（docs/部署.md“恢复演练”）"
  TAG=$(cat "$SRC/.deploy/current")
  SITE=$(cat "$SRC/.deploy/site")
fi
release_exists "$TAG" || die "$CODE 下线时的版本 $TAG 的镜像不在了：先 git checkout $TAG 再 deploy/build.sh，再跑一次这个命令（起回来以后再升级）"
# 这段时间站点地址可能给了别家：照开户一样查一遍
check_site "$CODE" "$SITE"

if [ ! -e "$DIR" ]; then
  mkdir -p "$TENANTS_DIR"
  mv "$SRC" "$DIR"
  touch "$MARK"
  record "$CODE" "从 $SRC 起回来"
fi
trap 's=$?; [ $s -eq 0 ] || echo "起回来中途失败：看上面的报错，改好以后再跑一次 deploy/tenant-restore.sh $CODE 接着做（客户现在还打不开，巡检也会报）" >&2' EXIT

docker network inspect erp-proxy > /dev/null 2>&1 || docker network create erp-proxy > /dev/null
log "1/4 起数据库、应用和备份（版本 $TAG，库是原来的）"
dc "$CODE" up -d --no-build app backup
wait_healthy "$CODE" 180 || die "$CODE 的应用没起来：deploy/dc.sh $CODE logs app"

# 最新的备份、定时任务的成功时间都停在下线那天，不刷新巡检会连着报“备份停了”“任务好久没跑”（复查第 94 条）
log "2/4 马上备份一份"
dc "$CODE" run --rm -T backup now || die "起回来以后的备份没做成：deploy/dc.sh $CODE logs backup"
log "3/4 对一遍账"
dc "$CODE" run --rm -T tools pnpm -s db:check || die "起回来以后对账对不上（看上面哪一类），先查清楚再给客户用；站点还没加，客户打不开"
mkdir -p "$DIR/.ops"
for task in daily db-check alerts-run; do date +%s > "$DIR/.ops/last-$task"; done
echo 0 > "$DIR/.ops/health-fails"

log "4/4 共享 Caddy 加回 $SITE"
install_site "$CODE" "$SITE"
rm -f "$MARK"
record "$CODE" "起回来完成"
log "$CODE 起回来了，数据原样（版本 $TAG，站点 $SITE）；到期了的用 deploy/dc.sh $CODE run --rm tools pnpm license:set 续费"
