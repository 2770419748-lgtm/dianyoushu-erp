#!/usr/bin/env bash
# 部署演练（口径第 24 节）：在 CI 机器上按“一台服务器放两家客户”把 deploy/ 下的脚本真跑一遍——
# 开两家 → 经共享 Caddy 按子域名访问 → 一家升级成功 → 另一家升到坏版本、自动回滚 → 手动回滚 → 定时任务 →
# 恢复演练 → 批量升级 → 巡检发现应用停了告警 → 备份同步到“异地”（本机目录模拟）。最后全部拆掉。
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
  docker compose -p erp-proxy -f "$D/proxy/docker-compose.yml" logs --tail 20 caddy >&2 2>&1
  exit 1
}
health() { curl -fsS -m 5 -H "Host: $1.test" "http://127.0.0.1:$PROXY_HTTP_PORT/api/health"; }
mask() { sed -E 's/初始密码 [A-Za-z0-9]{12}/初始密码 ************/'; }

cleanup() {
  for t in t1 t2; do [ -f "$(tenant_dir $t)/.env" ] && dc "$t" down -v --remove-orphans > /dev/null 2>&1; done
  docker compose -p erp-proxy -f "$D/proxy/docker-compose.yml" down -v > /dev/null 2>&1
  docker network rm erp-proxy > /dev/null 2>&1
  rm -rf "$ERP_ROOT"
}
trap cleanup EXIT
rm -rf "$ERP_ROOT"
mkdir -p "$ERP_ROOT"
echo "OFFSITE_REMOTE=:local:$ERP_ROOT/offsite" > "$ERP_ROOT/ops.env"

step "准备版本：v1、v2（同一个镜像换标签，模拟新版本）、bad（一起来就退出的坏版本）"
docker tag dianyoushu-erp:ci dianyoushu-erp:v1 || fail "没有 dianyoushu-erp:ci 镜像"
docker build -q --target build -t dianyoushu-erp-tools:v1 "$APP_DIR" > /dev/null || fail "打工具镜像失败"
docker tag dianyoushu-erp:v1 dianyoushu-erp:v2
docker tag dianyoushu-erp-tools:v1 dianyoushu-erp-tools:v2
printf 'FROM dianyoushu-erp:v1\nCMD ["node", "-e", "process.exit(1)"]\n' | docker build -q -t dianyoushu-erp:bad - > /dev/null || fail "打坏版本失败"
docker tag dianyoushu-erp-tools:v1 dianyoushu-erp-tools:bad
for v in v1 v2 bad; do docker tag dianyoushu-erp-backup:ci "dianyoushu-erp-backup:$v" || fail "没有 dianyoushu-erp-backup:ci 镜像"; done

step "开两家客户"
"$D/tenant-new.sh" t1 http://t1.test v1 --name "演练一号" 2>&1 | mask
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "开 t1 失败"
"$D/tenant-new.sh" t2 http://t2.test v1 --name "演练二号" 2>&1 | mask
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "开 t2 失败"
health t1 && health t2 || fail "经共享 Caddy 访问不到"
echo
[ "$(stat -c %a "$(tenant_dir t1)/.env")" = 600 ] || fail ".env 不是 600"
echo "两家都开好了，经 Caddy 按子域名访问正常，.env 只有属主能读"

step "t1 升级到 v2"
"$D/deploy.sh" t1 v2 --force || fail "t1 升级失败"
[ "$(current_tag t1)" = v2 ] && [ "$(previous_tag t1)" = v1 ] || fail "t1 的版本记录不对"
health t1 || fail "t1 升级后访问不到"
ls "$(tenant_dir t1)"/backups/*.dump.enc > /dev/null || fail "升级前没有备份"
echo
echo "t1 升级成功，升级前备份了一份"

step "t2 升级到坏版本：要自动回滚到 v1"
if "$D/deploy.sh" t2 bad --force; then fail "坏版本竟然升级成功了"; fi
[ "$(current_tag t2)" = v1 ] || fail "t2 没回滚到 v1（现在是 $(current_tag t2)）"
health t2 || fail "t2 回滚后访问不到"
grep -q "已回滚到 v1" "$(tenant_dir t2)/.deploy/history.log" || fail "发布记录里没有回滚"
echo
echo "坏版本健康检查不过，自动回滚到 v1，照常能用"

step "t1 手动回滚到 v1"
"$D/rollback.sh" t1 || fail "手动回滚失败"
[ "$(current_tag t1)" = v1 ] || fail "t1 没回到 v1"
health t1 || fail "t1 回滚后访问不到"
echo
echo "手动回滚成功"

step "定时任务：对账、每日任务"
"$D/run-all.sh" db:check || fail "对账失败"
"$D/run-all.sh" daily || fail "每日任务失败"
[ -f "$(tenant_dir t2)/.ops/last-db-check" ] && [ -f "$(tenant_dir t2)/.ops/last-daily" ] || fail "没记下成功时间"

step "恢复演练"
"$D/restore-drill.sh" || fail "恢复演练失败"

step "批量升级到 v2（没有演示站，跳过演示站检查）"
"$D/upgrade-all.sh" v2 --force --skip-demo-check || fail "批量升级失败"
[ "$(current_tag t1)" = v2 ] && [ "$(current_tag t2)" = v2 ] || fail "批量升级后版本不对"
health t1 && health t2 || fail "批量升级后访问不到"
echo

step "巡检：t2 的应用停了，连续 3 次告警"
dc t2 stop app > /dev/null 2>&1
out=$(for i in 1 2 3; do "$D/health-check.sh" 2>&1; done)
echo "$out" | grep -q "t2 连续 3 次健康检查不通" || {
  echo "$out"
  fail "巡检没告警"
}
echo "$out" | grep -q "t1 连续" && fail "t1 好好的却告警了"
dc t2 start app > /dev/null 2>&1
wait_healthy t2 120 || fail "t2 重新起来不健康"
"$D/health-check.sh" 2>&1 | grep -q "t2 恢复了" || fail "恢复后没说"
echo "巡检告警、恢复都对"

step "备份同步到异地（本机目录模拟对象存储）"
"$D/offsite-sync.sh" || fail "备份同步失败"
ls "$ERP_ROOT/offsite/t1/"*.dump.enc > /dev/null && ls "$ERP_ROOT/offsite/t2/"*.dump.enc > /dev/null || fail "异地没有备份文件"
echo "两家的备份都同步过去了"

echo
echo "部署演练：开户、子域名访问、升级、坏版本自动回滚、手动回滚、定时任务、恢复演练、批量升级、巡检告警、异地备份都通"
