#!/usr/bin/env bash
# 部署演练（口径第 24 节）：在 CI 机器上按“一台服务器放两家客户”把 deploy/ 下的脚本真跑一遍——
# 开两家（站点地址重复、带端口、现有站点文件坏了都不开）→ 经共享 Caddy 按子域名访问 →
# 升级到带“不能直接回滚”迁移的版本、手动回滚被拒绝 → 没有新迁移的升级能手动回滚 → 坏版本自动回滚 →
# 带不能回滚迁移的坏版本不自动回滚、修好新版本再升 → 定时任务 → 恢复演练 → 备份停了巡检和恢复演练都报 →
# 批量升级 → 应用停了连续告警、恢复 → 共享 Caddy 停了巡检报 → 备份同步到“异地”（本机目录模拟）→ 下线一家。最后全部拆掉。
# 前提：已经有 dianyoushu-erp:ci、dianyoushu-erp-backup:ci 镜像（CI 的“打生产镜像”“加密备份”两步打的），装了 rclone。用法：deploy/drill.sh
set -euo pipefail

export ERP_ROOT="${ERP_ROOT:-${RUNNER_TEMP:-/tmp}/erp-drill}"
export APP_DIR
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PROXY_HTTP_PORT=8088 PROXY_HTTPS_PORT=8443
D="$APP_DIR/deploy"
. "$D/lib.sh"
set +e # 下面每一步自己判断结果
step() { echo; echo "===== $* ====="; }
fail() {
  echo "演练失败：$*" >&2
  for t in t1 t2; do
    [ -f "$(tenant_dir $t)/.env" ] || continue
    echo "----- $t 的应用日志（最后 40 行）-----" >&2
    dc "$t" logs --tail 40 app >&2 2>&1
    echo "----- $t 的发布记录 -----" >&2
    cat "$(tenant_dir $t)/.deploy/history.log" >&2 2>/dev/null
  done
  proxy_dc logs --tail 20 caddy >&2 2>&1
  exit 1
}
# 经共享 Caddy 按子域名访问，要看到应用回的 {"ok":true}（Caddy 对没配的站点也回 200）
health() {
  local body
  body=$(curl -fsS -m 5 -H "Host: $1.test" "http://127.0.0.1:$PROXY_HTTP_PORT/api/health") && [[ "$body" == *'"ok":true'* ]]
}
history_has() { grep -q "$2" "$(tenant_dir "$1")/.deploy/history.log"; }
mask() { sed -E 's/初始密码 [A-Za-z0-9]{12}/初始密码 ************/'; }

cleanup() {
  for t in t1 t2; do [ -f "$(tenant_dir $t)/.env" ] && dc "$t" down -v --remove-orphans > /dev/null 2>&1; done
  proxy_dc down -v > /dev/null 2>&1
  docker network rm erp-proxy > /dev/null 2>&1
  rm -rf "$ERP_ROOT"
}
trap cleanup EXIT
rm -rf "$ERP_ROOT"
mkdir -p "$ERP_ROOT"
echo "OFFSITE_REMOTE=:local:$ERP_ROOT/offsite" > "$ERP_ROOT/ops.env"

step "准备版本"
# v1；v2 = v1 加一个标了“不能直接回滚”的迁移（模拟枚举加值）；v3 = v2 之后没有新迁移的小修复；
# bad = 一起来就退出的坏版本（没有新迁移）；bad-mig = 坏版本，而且带 v2 那个不能回滚的迁移
docker tag dianyoushu-erp:ci dianyoushu-erp:v1 || fail "没有 dianyoushu-erp:ci 镜像"
docker build -q --target build -t dianyoushu-erp-tools:v1 "$APP_DIR" > /dev/null || fail "打工具镜像失败"
M=20991231000000_drill_enum
printf '%s\n' "FROM dianyoushu-erp-tools:v1" \
  "RUN mkdir prisma/migrations/$M && echo 'SELECT 1;' > prisma/migrations/$M/migration.sql && echo '$M 演练：模拟枚举加值' >> prisma/migrations-not-rollback-safe.txt" |
  docker build -q -t dianyoushu-erp-tools:v2 - > /dev/null || fail "打 v2 工具镜像失败"
printf 'FROM dianyoushu-erp:v1\nCMD ["node", "-e", "process.exit(1)"]\n' | docker build -q -t dianyoushu-erp:bad - > /dev/null || fail "打坏版本失败"
docker tag dianyoushu-erp:v1 dianyoushu-erp:v2
docker tag dianyoushu-erp:v1 dianyoushu-erp:v3
docker tag dianyoushu-erp:bad dianyoushu-erp:bad-mig
docker tag dianyoushu-erp-tools:v2 dianyoushu-erp-tools:v3
docker tag dianyoushu-erp-tools:v1 dianyoushu-erp-tools:bad
docker tag dianyoushu-erp-tools:v2 dianyoushu-erp-tools:bad-mig
for v in v1 v2 v3 bad bad-mig; do docker tag dianyoushu-erp-backup:ci "dianyoushu-erp-backup:$v" || fail "没有 dianyoushu-erp-backup:ci 镜像"; done

step "开两家客户"
"$D/tenant-new.sh" t1 http://t1.test v1 --name "演练一号" 2>&1 | mask
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "开 t1 失败"
"$D/tenant-new.sh" t2 http://t2.test v1 --name "演练二号" 2>&1 | mask
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "开 t2 失败"
health t1 && health t2 || fail "经共享 Caddy 访问不到"
[ "$(stat -c %a "$(tenant_dir t1)/.env")" = 600 ] || fail ".env 不是 600"
echo "两家都开好了，经 Caddy 按子域名访问正常，.env 只有属主能读"

step "站点地址：和别家重复的、带端口的、现有站点文件被改坏的，都不开户，别家不受影响"
refuse() {
  local out
  if out=$("$D/tenant-new.sh" t3 "$1" v1 --name "演练三号" 2>&1); then fail "$2 竟然开户了"; fi
  echo "$2：$(tail -1 <<< "$out")"
  [ -e "$(tenant_dir t3)" ] && fail "$2 没开成，却留下了目录"
  [ -e "$PROXY_DIR/sites/t3.caddy" ] && fail "$2 没开成，却留下了站点"
  return 0
}
refuse http://T1.test "和 t1 重复的站点地址"
refuse http://t3.test:8080 "带端口的站点地址"
printf 't9.test {\n' > "$PROXY_DIR/sites/zz.caddy" # 模拟有人手改坏了一个站点文件（少了右括号）
refuse http://t3.test "现有站点文件坏了"
rm -f "$PROXY_DIR/sites/zz.caddy"
health t1 && health t2 || fail "拒绝开户以后 t1、t2 访问不到"
echo "都拒绝了，没留下半家，t1、t2 照常"

step "t1 升级到 v2（带一个不能直接回滚的迁移）"
"$D/deploy.sh" t1 v2 --force || fail "t1 升级失败"
[ "$(current_tag t1)" = v2 ] && [ "$(previous_tag t1)" = v1 ] || fail "t1 的版本记录不对"
health t1 || fail "t1 升级后访问不到"
ls "$(tenant_dir t1)"/backups/*.dump.enc > /dev/null || fail "升级前没有备份"
history_has t1 "含不能直接回滚的迁移：$M" || fail "发布记录里没记下不能直接回滚的迁移"
echo "t1 升级成功，升级前备份了一份，发布记录写明了这次有不能直接回滚的迁移"

step "t1 手动回滚到 v1：做过不能直接回滚的迁移，要拒绝"
if "$D/rollback.sh" t1; then fail "做过不能直接回滚的迁移，竟然回滚了"; fi
[ "$(current_tag t1)" = v2 ] || fail "拒绝回滚却换了版本（现在是 $(current_tag t1)）"
health t1 || fail "拒绝回滚以后 t1 访问不到"
echo "拒绝了，t1 还在 v2 上照常用"

step "t1 升级到 v3（没有新迁移）再手动回滚到 v2：能回"
"$D/deploy.sh" t1 v3 --force || fail "t1 升级到 v3 失败"
"$D/rollback.sh" t1 || fail "手动回滚失败"
[ "$(current_tag t1)" = v2 ] || fail "t1 没回到 v2"
health t1 || fail "t1 回滚后访问不到"
history_has t1 "回滚 v3 → v2 成功" || fail "发布记录里没有回滚"
echo "手动回滚成功，回滚后用旧版本对账通过"

step "t2 升级到坏版本：要自动回滚到 v1"
if "$D/deploy.sh" t2 bad --force; then fail "坏版本竟然升级成功了"; fi
[ "$(current_tag t2)" = v1 ] || fail "t2 没回滚到 v1（现在是 $(current_tag t2)）"
health t2 || fail "t2 回滚后访问不到"
history_has t2 "已回滚到 v1" || fail "发布记录里没有回滚"
echo "坏版本健康检查不过，自动回滚到 v1，照常能用"

step "t2 升级到带不能回滚迁移的坏版本：不自动回滚，修好新版本再升"
if "$D/deploy.sh" t2 bad-mig --force; then fail "坏版本竟然升级成功了"; fi
[ "$(current_tag t2)" = bad-mig ] || fail "做过不能直接回滚的迁移，不该自动回滚（现在是 $(current_tag t2)）"
history_has t2 "迁移不能直接回滚，没回滚" || fail "发布记录里没说为什么没回滚"
"$D/deploy.sh" t2 v2 --force || fail "修好的新版本升不上去"
health t2 || fail "t2 升到修好的版本后访问不到"
echo "没有硬回到读不了新数据的旧版本；升到修好的版本以后照常"

step "定时任务：对账、每日任务"
"$D/run-all.sh" db:check || fail "对账失败"
"$D/run-all.sh" daily || fail "每日任务失败"
[ -f "$(tenant_dir t2)/.ops/last-db-check" ] && [ -f "$(tenant_dir t2)/.ops/last-daily" ] || fail "没记下成功时间"

step "恢复演练"
"$D/restore-drill.sh" || fail "恢复演练失败"

step "备份停了：t2 的备份容器停了、最新的备份是 30 小时前的，巡检和恢复演练都要报"
dc t2 stop backup > /dev/null 2>&1
touch -d '30 hours ago' "$(tenant_dir t2)"/backups/*.dump.enc
touch -d '2 days ago' "$(tenant_dir t2)/.env" # 开户不满 26 小时的不查备份年龄
# 先把输出存下来再找：直接 | grep -q 会在找到后关掉管道，巡检后面再写就收到 SIGPIPE，pipefail 下整条算失败
out=$("$D/health-check.sh" 2>&1)
grep -q "t2 的备份容器没在跑" <<< "$out" && grep -q "t2 最新一份备份是 30 小时前的" <<< "$out" || {
  echo "$out"
  fail "巡检没报备份停了"
}
grep -qE "t1 的备份|t1 最新一份备份|t1 一份备份" <<< "$out" && fail "t1 的备份好好的却告警了"
dc t2 start backup > /dev/null 2>&1
if out=$("$D/restore-drill.sh" t2 2>&1); then
  echo "$out"
  fail "备份过期了，恢复演练竟然通过"
fi
grep -q "每天的备份停了" <<< "$out" || {
  echo "$out"
  fail "恢复演练没说备份过期"
}
dc t2 exec -T backup bash /backup.sh now > /dev/null || fail "补一份备份失败"
"$D/restore-drill.sh" t2 || fail "补了备份以后恢复演练不通过"
echo "巡检报了备份容器没在跑、备份过期，恢复演练也不通过；补了备份以后通过"

step "批量升级到 v3（没有演示站，跳过演示站检查）"
"$D/upgrade-all.sh" v3 --force --skip-demo-check || fail "批量升级失败"
[ "$(current_tag t1)" = v3 ] && [ "$(current_tag t2)" = v3 ] || fail "批量升级后版本不对"
health t1 && health t2 || fail "批量升级后访问不到"

step "巡检：t2 的应用停了，连续 3 次告警"
dc t2 stop app > /dev/null 2>&1
out=$(for i in 1 2 3; do "$D/health-check.sh" 2>&1; done)
grep -q "t2 连续 3 次健康检查不通" <<< "$out" || {
  echo "$out"
  fail "巡检没告警"
}
grep -q "t1 连续" <<< "$out" && fail "t1 好好的却告警了"
dc t2 start app > /dev/null 2>&1
wait_healthy t2 120 || fail "t2 重新起来不健康"
out=$("$D/health-check.sh" 2>&1)
grep -q "t2 恢复了" <<< "$out" || {
  echo "$out"
  fail "恢复后没说"
}
echo "巡检告警、恢复都对"

step "巡检：共享 Caddy 停了"
proxy_dc stop caddy > /dev/null 2>&1
out=$("$D/health-check.sh" 2>&1)
grep -q "共享 Caddy 没在跑" <<< "$out" && grep -q "经共享 Caddy 访问 http://t1.test 不通" <<< "$out" || {
  echo "$out"
  fail "巡检没发现共享 Caddy 停了"
}
proxy_dc start caddy > /dev/null 2>&1
for _ in $(seq 1 30); do health t1 && break; sleep 1; done
health t1 && health t2 || fail "共享 Caddy 起来以后访问不到"
out=$("$D/health-check.sh" 2>&1)
grep -q "Caddy" <<< "$out" && {
  echo "$out"
  fail "共享 Caddy 起来以后巡检还在报"
}
echo "巡检报了共享 Caddy 没在跑、每家经 Caddy 访问不通；起来以后不报了"

step "备份同步到异地（本机目录模拟对象存储）"
"$D/offsite-sync.sh" || fail "备份同步失败"
ls "$ERP_ROOT/offsite/t1/"*.dump.enc > /dev/null && ls "$ERP_ROOT/offsite/t2/"*.dump.enc > /dev/null || fail "异地没有备份文件"
echo "两家的备份都同步过去了"

step "下线 t2"
"$D/tenant-remove.sh" t2 --purge || fail "下线 t2 失败"
[ -e "$(tenant_dir t2)" ] && fail "t2 的目录还在"
ls "$ERP_ROOT"/removed/t2-*/backups/*.dump.enc > /dev/null || fail "下线以后备份没留下"
[ -e "$PROXY_DIR/sites/t2.caddy" ] && fail "t2 的站点还在共享 Caddy 上"
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=erp-t2)" ] || fail "t2 的容器还在"
health t2 && fail "下线了还能访问到 t2"
health t1 || fail "下线 t2 以后 t1 访问不到"
echo "t2 下线了：容器、库、站点都拿掉，目录（备份、.env）挪到 removed/；t1 照常"

echo
echo "部署演练：开户（站点地址重复、带端口、配置坏了都拒绝）、子域名访问、升级、不能直接回滚的迁移拒绝回滚、手动回滚、坏版本自动回滚、带不能回滚迁移的坏版本不回滚、定时任务、恢复演练、备份停了告警、批量升级、巡检告警、共享 Caddy 停了告警、异地备份、下线都通"
