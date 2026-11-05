#!/usr/bin/env bash
# สำรอง DB รายวัน เก็บ 14 วันในเครื่อง — **ต้องส่งออกนอกเครื่องด้วย** (rclone/rsync/object storage)
# ติดตั้ง: ln -s /opt/pos/app/deploy/backup.sh /etc/cron.daily/pos-backup
# ทดสอบ restore สม่ำเสมอ: createdb pos_restore && pg_restore -d pos_restore <ไฟล์>
set -euo pipefail
dir=/var/backups/pos
install -d -m 700 -o postgres -g postgres "$dir"
f="$dir/pos-$(date +%F).dump"
sudo -u postgres pg_dump -Fc -f "$f" pos
find "$dir" -name 'pos-*.dump' -mtime +14 -delete
# ตัวอย่างส่งออก: rclone copy "$f" remote:pos-backups/
