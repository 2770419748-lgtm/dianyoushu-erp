#!/usr/bin/env bash
# 把下线了（没加 --purge、库卷还留着）的客户原样起回来（口径第 24 节，复查第 93 条）：老客户回来续费时用，不要用 tenant-new.sh 重开
# （新 .env 的密码连不上老库，开户会失败）。
# $ERP_ROOT/removed/ 里这家最新的那份目录挪回 tenants/ → 用原来的 .env 和版本接上留着的库卷 → 起应用和备份 → 共享 Caddy 加回原来的站点地址。
# 到期了的起回来以后续费：deploy/dc.sh <代号> run --rm tools pnpm license:set --days 365
# 用法：deploy/tenant-restore.sh <代号>
. "$(dirname "$0")/lib.sh"

CODE=${1:-}
valid_code "$CODE" || die "用法：deploy/tenant-restore.sh <代号>"
DIR=$(tenant_dir "$CODE")
[ -e "$DIR" ] && die "已经有 $CODE 了：$DIR"
# 下线时挪去的目录叫 <代号>-<日期>-<时间>；按名字精确匹配，代号是 t2 时不会挑到 t2-shop 的
NAME=$(ls -1 "$ERP_ROOT/removed" 2> /dev/null | grep -E "^$CODE-[0-9]{8}-[0-9]{6}$" | sort | tail -1 || true)
[ -n "$NAME" ] && [ -f "$ERP_ROOT/removed/$NAME/.env" ] || die "$ERP_ROOT/removed/ 里没有 $CODE 下线留下的目录"
SRC="$ERP_ROOT/removed/$NAME"
[ -n "$(tenant_volumes "$CODE")" ] || die "$CODE 的库卷不在了（下线时加了 --purge）：只能另开户以后用 $SRC/backups 里的备份恢复（docs/部署.md“恢复演练”）"
TAG=$(cat "$SRC/.deploy/current")
release_exists "$TAG" || die "$CODE 下线时的版本 $TAG 的镜像不在了：先 git checkout $TAG 再 deploy/build.sh，起回来以后再升级"
SITE=$(cat "$SRC/.deploy/site")
# 这段时间站点地址可能给了别家：照开户一样查一遍
check_site "$CODE" "$SITE"

mkdir -p "$TENANTS_DIR"
mv "$SRC" "$DIR"
record "$CODE" "从 $SRC 起回来"
docker network inspect erp-proxy > /dev/null 2>&1 || docker network create erp-proxy > /dev/null
log "起数据库、应用和备份（版本 $TAG，库是原来的）"
dc "$CODE" up -d --no-build app backup
wait_healthy "$CODE" 180 || die "$CODE 的应用没起来：deploy/dc.sh $CODE logs app"
log "共享 Caddy 加回 $SITE"
install_site "$CODE" "$SITE"
record "$CODE" "起回来完成"
log "$CODE 起回来了，数据原样（版本 $TAG，站点 $SITE）；到期了的用 deploy/dc.sh $CODE run --rm tools pnpm license:set 续费"
