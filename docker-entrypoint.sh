#!/bin/sh
set -eu

mkdir -p /app/data/uploads /app/data/knowledge

# 命名卷首次挂载为空目录时，把镜像内知识库 seed 拷进去
if [ -z "$(ls -A /app/data/knowledge 2>/dev/null || true)" ]; then
  if [ -d /app/knowledge-seed ]; then
    echo "[entrypoint] seeding knowledge base into /app/data/knowledge"
    cp -a /app/knowledge-seed/. /app/data/knowledge/
  fi
fi

exec node dist/index.js
