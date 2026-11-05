#!/usr/bin/env bash
# ดึง IP range ของ Cloudflare แล้วเขียน /etc/caddy/trusted_proxies.conf จากนั้น reload Caddy
# ตั้ง cron รายสัปดาห์: ln -s /opt/pos/app/deploy/update-cf-ips.sh /etc/cron.weekly/update-cf-ips
set -euo pipefail

OUT=/etc/caddy/trusted_proxies.conf
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

ranges=$(curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4; echo; curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6)
list=$(echo "$ranges" | tr -s '[:space:]' '\n' | grep -E '^[0-9a-fA-F:.]+/[0-9]{1,3}$' | tr '\n' ' ')

# กันกรณีดึงมาไม่ครบ: ต้องมีอย่างน้อย 10 ช่วง ไม่งั้นคงไฟล์เดิมไว้
count=$(wc -w <<<"$list")
if [ "$count" -lt 10 ]; then
  echo "got only $count ranges, keeping existing $OUT" >&2
  exit 1
fi

echo "trusted_proxies static $list" >"$tmp"
install -m 644 "$tmp" "$OUT"
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy
echo "updated $count Cloudflare ranges"
