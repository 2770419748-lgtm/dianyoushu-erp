# 备份服务的镜像（docker compose 的 backup 服务）：PostgreSQL 17 自带 pg_dump，再装上 openssl 用来加密备份（口径第 20 节）。
FROM postgres:17
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
