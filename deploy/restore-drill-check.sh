# 恢复演练在备份容器里跑的那一段（deploy/restore-drill.sh 用 bash -s 喂进去，不要在服务器上直接跑）。
# 容器里有 pg_restore、openssl、备份口令（BACKUP_PASSPHRASE）和连 db 的密码（PGPASSWORD）。
set -euo pipefail
f=$(ls -1t /backups/*.dump.enc 2> /dev/null | head -1)
[ -n "$f" ] || { echo "没有备份文件"; exit 1; }
age=$((($(date +%s) - $(stat -c %Y "$f")) / 3600))
echo "最新的备份：$(basename "$f")（$age 小时前）"
[ "$age" -le 26 ] || { echo "最新的备份是 $age 小时前的：每天的备份停了"; exit 1; }

export PGHOST=db PGUSER=erp
dropdb --if-exists restore_drill
createdb restore_drill
work=$(mktemp -d)
trap 'dropdb --if-exists restore_drill; rm -rf "$work"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$f" | pg_restore -d restore_drill --no-owner --exit-on-error

# 逐张表数行数（query_to_xml 在一条语句里数完每张表）
rows="SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', table_name), false, true, '')))[1]::text
FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"
psql -d dianyoushu_erp -tA -F '|' -c "$rows" > "$work/live"
psql -d restore_drill -tA -F '|' -c "$rows" > "$work/drill"

# 正式库在备份之后还在记账，两边行数本来就对不上：逐张列出来，正式库有、恢复出来没有的表算失败，
# 正式库有数据、恢复出来是空的标出来（多半是备份之后才开始用的功能，看一眼）
awk -F '|' '
  NR == FNR { live[$1] = $2; next }
  { drill[$1] = $2 }
  END {
    bad = 0
    for (t in live) {
      if (!(t in drill)) { printf "  %s：正式库有 %s 行，恢复出来没有这张表\n", t, live[t]; bad = 1; continue }
      mark = (drill[t] == 0 && live[t] > 0) ? "  ← 恢复出来是空的" : ""
      printf "  %s：恢复 %s 行，正式库 %s 行%s\n", t, drill[t], live[t], mark
    }
    exit bad
  }' "$work/live" "$work/drill" | sort || { echo "恢复出来的库少了表"; exit 1; }

live_mig=$(psql -d dianyoushu_erp -tAc "SELECT count(*) FROM _prisma_migrations")
drill_mig=$(psql -d restore_drill -tAc "SELECT count(*) FROM _prisma_migrations")
users=$(psql -d restore_drill -tAc "SELECT count(*) FROM users")
echo "表：正式库 $(wc -l < "$work/live") 张，恢复出来 $(wc -l < "$work/drill") 张；迁移记录：$live_mig / $drill_mig；员工：$users 个"
[ "$live_mig" = "$drill_mig" ] || echo "注意：迁移记录条数不一样（备份之后升过级？），看一下是不是这个原因"
[ "$users" -gt 0 ] || { echo "恢复出来的库里一个员工都没有"; exit 1; }
