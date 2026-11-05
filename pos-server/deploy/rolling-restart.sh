#!/usr/bin/env bash
# รีสตาร์ท API ทีละ instance — Caddy health check ย้ายทราฟฟิกไปอีกตัวระหว่างนั้น (ไม่มี downtime)
# migration ต้อง backward-compatible (เพิ่มคอลัมน์/ตารางเท่านั้น) เพราะโค้ดเก่าและใหม่รันคู่กันชั่วคราว
set -euo pipefail

for port in 3001 3002; do
  echo "restarting pos-api@$port"
  systemctl restart "pos-api@$port"
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      echo "  healthy"
      continue 2
    fi
    sleep 1
  done
  echo "pos-api@$port did not become healthy; aborting (the other instance keeps serving)" >&2
  exit 1
done
systemctl restart pos-worker
echo "done"
