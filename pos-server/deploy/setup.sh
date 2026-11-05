#!/usr/bin/env bash
# ติดตั้งบน Debian 13 (fresh) — รันเป็น root:
#   BASE_DOMAIN=order.example.com ACME_EMAIL=you@example.com bash deploy/setup.sh
# รันซ้ำได้ (ไม่เขียนทับ secret/รหัสผ่านที่มีอยู่แล้ว)
set -euo pipefail

: "${BASE_DOMAIN:?set BASE_DOMAIN (ร้านจะเป็น <slug>.BASE_DOMAIN)}"
: "${ACME_EMAIL:?set ACME_EMAIL}"
BUN_VERSION="${BUN_VERSION:-1.4.4}"   # เวอร์ชันที่ทดสอบ pin ไว้
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/pos/app

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
apt-get update -y
apt-get install -y postgresql ufw curl gnupg ca-certificates openssl unzip debian-keyring debian-archive-keyring apt-transport-https

echo "== caddy (repo ทางการ ต้อง >= 2.7)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "== bun $BUN_VERSION"
if ! /usr/local/bin/bun --version 2>/dev/null | grep -qx "$BUN_VERSION"; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local/bun bash -s "bun-v$BUN_VERSION"
  ln -sf /usr/local/bun/bin/bun /usr/local/bin/bun
fi

echo "== user + app files"
id pos >/dev/null 2>&1 || useradd -r -m -d /opt/pos -s /usr/sbin/nologin pos
install -d -o pos -g pos /opt/pos "$APP" /opt/pos/web
install -d -m 750 -o root -g pos /etc/pos
tar -C "$SRC" --exclude=node_modules --exclude=.git -cf - . | tar -C "$APP" -xf -
cp -a "$SRC/web/." /opt/pos/web/
chown -R pos:pos "$APP" /opt/pos/web
(cd "$APP" && sudo -u pos HOME=/opt/pos /usr/local/bin/bun install --production)

echo "== secrets + database"
if [ ! -f /etc/pos/env ]; then
  app_pw=$(openssl rand -hex 24)
  mig_pw=$(openssl rand -hex 24)
  umask 077
  tmpsql=$(mktemp /tmp/pos-setup.XXXXXX.sql)
  chown postgres "$tmpsql"
  printf "\\\\set migrate_pw '%s'\n\\\\set app_pw '%s'\n\\\\i %s/deploy/db-setup.sql\n" "$mig_pw" "$app_pw" "$APP" >"$tmpsql"
  sudo -u postgres psql -q -f "$tmpsql"
  rm -f "$tmpsql"

  cat >/etc/pos/env <<EOF
DATABASE_URL=postgres://pos_app:${app_pw}@127.0.0.1:5432/pos
BASE_DOMAIN=${BASE_DOMAIN}
GUEST_QR_SECRET=$(openssl rand -base64 48 | tr -d '\n')
EOF
  chown root:pos /etc/pos/env && chmod 640 /etc/pos/env
  # ข้อมูลรับรองสำหรับ migrate/admin เก็บแยก ให้ service (user pos) อ่านไม่ได้
  echo "ADMIN_DATABASE_URL=postgres://pos_migrate:${mig_pw}@127.0.0.1:5432/pos" >/etc/pos/admin.env
  chown root:root /etc/pos/admin.env && chmod 600 /etc/pos/admin.env
else
  echo "  /etc/pos/env exists, keeping"
fi

cat >/usr/local/bin/pos-admin <<'EOF'
#!/usr/bin/env bash
# ใช้: pos-admin migrate | pos-admin create-tenant <slug> <name> | ... (ดู src/admin.ts)
set -euo pipefail
set -a; . /etc/pos/env; . /etc/pos/admin.env; set +a
cd /opt/pos/app
if [ "${1:-}" = "migrate" ]; then exec /usr/local/bin/bun run src/migrate.ts; fi
exec /usr/local/bin/bun run src/admin.ts "$@"
EOF
chmod 750 /usr/local/bin/pos-admin
pos-admin migrate

echo "== postgres: listen เฉพาะ localhost"
pgconf=$(sudo -u postgres psql -tAc 'show config_file')
grep -Eq "^\s*listen_addresses\s*=\s*'localhost'" "$pgconf" || echo "listen_addresses = 'localhost'" >>"$pgconf"
systemctl restart postgresql

echo "== caddy"
install -d -o caddy -g caddy /var/log/caddy
[ -f /etc/caddy/trusted_proxies.conf ] || echo "# เติมโดย update-cf-ips.sh ถ้าใช้ Cloudflare" >/etc/caddy/trusted_proxies.conf
sed "s/ADMIN_EMAIL_PLACEHOLDER/${ACME_EMAIL}/" "$APP/deploy/Caddyfile" >/etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --now caddy
systemctl reload caddy

echo "== services"
install -m 644 "$APP/deploy/pos-api@.service" /etc/systemd/system/
install -m 644 "$APP/deploy/pos-worker.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pos-api@3001 pos-api@3002 pos-worker
ln -sf "$APP/deploy/backup.sh" /etc/cron.daily/pos-backup
chmod +x "$APP"/deploy/*.sh

echo "== firewall"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

cat <<EOF

เสร็จแล้ว ขั้นต่อไป:
  1) DNS: *.${BASE_DOMAIN} (A/AAAA) ชี้มาที่เครื่องนี้
  2) ถ้าใช้ Cloudflare: bash $APP/deploy/update-cf-ips.sh && ln -sf $APP/deploy/update-cf-ips.sh /etc/cron.weekly/update-cf-ips
  3) onboarding ร้านแรก:
       pos-admin create-tenant demo "Demo Restaurant"
       pos-admin add-table demo A1          # พิมพ์ URL ที่ได้เป็น QR
       pos-admin add-menu demo "ข้าวผัด" 60
       pos-admin add-staff demo cashier1 manager
  4) ตั้งส่งไฟล์สำรองออกนอกเครื่อง (deploy/backup.sh)
EOF
