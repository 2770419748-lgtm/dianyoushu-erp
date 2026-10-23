#!/bin/sh
# 数据库分账号（口径第 20 节）：
# - erp（POSTGRES_USER，表的所有者）：只给迁移、灌数据、对账这些运维脚本用（compose 的 tools 服务、backup 服务）；
# - erp_app：应用用，只能增删改查，不能改表结构、不能删表；
# - erp_readonly：只读，给以后查数、报表。
# 以后迁移新建的表自动给这两个账号授权（ALTER DEFAULT PRIVILEGES）。可以反复跑：账号已经有了就只改密码、补授权。
#
# 两种跑法：
# - 数据库第一次初始化时自动跑（compose 把它挂到 /docker-entrypoint-initdb.d/）；
# - 已经在跑的库补一次：.env 里加好两个密码（openssl rand -hex 32），docker compose up -d db 让 db 容器带上它们，再 docker compose exec db sh /db-roles.sh
#   （CI 里用 PGHOST、PGUSER、PGPASSWORD 连临时库，DB_OWNER 是表的所有者）。
set -eu

: "${APP_DB_PASSWORD:?没有设置 APP_DB_PASSWORD（应用连库用的业务账号密码）}"
: "${READONLY_DB_PASSWORD:?没有设置 READONLY_DB_PASSWORD（只读账号密码）}"
OWNER="${DB_OWNER:-${POSTGRES_USER:-erp}}"
DB="${POSTGRES_DB:-${PGDATABASE:-dianyoushu_erp}}"

psql -v ON_ERROR_STOP=1 --username "${PGUSER:-$OWNER}" --dbname "$DB" \
  -v app_pw="$APP_DB_PASSWORD" -v ro_pw="$READONLY_DB_PASSWORD" -v owner="$OWNER" -v db="$DB" <<'SQL'
SELECT format('CREATE ROLE erp_app LOGIN PASSWORD %L', :'app_pw') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') \gexec
SELECT format('CREATE ROLE erp_readonly LOGIN PASSWORD %L', :'ro_pw') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_readonly') \gexec
ALTER ROLE erp_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_pw';
ALTER ROLE erp_readonly WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'ro_pw';

GRANT CONNECT ON DATABASE :"db" TO erp_app, erp_readonly;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO erp_app, erp_readonly;

-- 已有的表和序列
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO erp_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO erp_readonly;

-- 以后迁移新建的（迁移用表的所有者跑）
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO erp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT ON TABLES TO erp_readonly;
SQL

echo "[db-roles] 已就绪：erp_app（增删改查）、erp_readonly（只读）；表所有者 $OWNER"
