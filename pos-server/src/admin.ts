// CLI สำหรับ onboarding ร้าน (ใช้ role pos_migrate ซึ่งเป็นเจ้าของตาราง จึงข้าม RLS ได้)
//   bun run admin create-tenant <slug> <name>
//   bun run admin add-table <slug> <label>
//   bun run admin print-urls <slug>
//   bun run admin rotate-qr <slug> <label>
//   bun run admin add-staff <slug> <name> <kitchen|cashier|manager>
//   bun run admin add-menu <slug> <name> <price_baht> [category]
//   bun run admin set-confirm <slug> <on|off>
//   bun run admin set-pos-map <slug> table <label> <pos_table_id> | menu <name> <pos_product_id>
//   bun run admin set-setting <slug> <key> <value>   (true|false|ตัวเลข) เช่น order_cooldown_sec 15
//   bun run admin set-reset <slug> <HH:MM|off> [tz]  เช่น 07:00 Asia/Bangkok
import postgres from "postgres";
import { config } from "./config.ts";
import { randomToken, sha256hex, tableToken } from "./crypto.ts";

const url = process.env.ADMIN_DATABASE_URL;
if (!url) throw new Error("ADMIN_DATABASE_URL is required");
const sql = postgres(url, { max: 1, onnotice: () => {} });

const [cmd, ...a] = process.argv.slice(2);
const scheme = config.baseDomain === "localhost" ? "http" : "https";
const qrUrl = (slug: string, tenantId: string, tableId: string, qv: number) =>
  `${scheme}://${slug}.${config.baseDomain}/t/${tableToken(tenantId, tableId, qv)}`;

async function tenant(slug?: string) {
  const [t] = await sql`select id, slug from tenant where slug = ${slug ?? ""}`;
  if (!t) throw new Error(`tenant not found: ${slug}`);
  return t;
}

try {
  switch (cmd) {
    case "create-tenant": {
      const [slug, ...name] = a;
      const [t] = await sql`insert into tenant (slug, name) values (${slug!}, ${name.join(" ")}) returning id, slug`;
      console.log(t);
      break;
    }
    case "add-table": {
      const t = await tenant(a[0]);
      const [r] = await sql`insert into dining_table (tenant_id, label) values (${t.id}, ${a[1]!}) returning id, qr_version`;
      console.log(qrUrl(t.slug, t.id, r!.id, r!.qr_version));
      break;
    }
    case "print-urls": {
      const t = await tenant(a[0]);
      for (const r of await sql`select id, label, qr_version from dining_table where tenant_id = ${t.id} and active order by label`)
        console.log(r.label.padEnd(10), qrUrl(t.slug, t.id, r.id, r.qr_version));
      break;
    }
    case "rotate-qr": {
      const t = await tenant(a[0]);
      const [r] = await sql`
        update dining_table set qr_version = qr_version + 1
        where tenant_id = ${t.id} and label = ${a[1]!} returning id, qr_version`;
      if (!r) throw new Error("table not found");
      console.log("new URL:", qrUrl(t.slug, t.id, r.id, r.qr_version));
      break;
    }
    case "add-staff": {
      const t = await tenant(a[0]);
      const token = randomToken();
      await sql`insert into staff_user (tenant_id, name, role, token_hash) values (${t.id}, ${a[1]!}, ${a[2]!}, ${sha256hex(token)})`;
      console.log("staff token (แสดงครั้งเดียว):", token);
      break;
    }
    case "add-menu": {
      const t = await tenant(a[0]);
      const price = Math.round(parseFloat(a[2] ?? "") * 100);
      if (!Number.isFinite(price)) throw new Error("bad price");
      const [r] = await sql`
        insert into menu_item (tenant_id, name, price_satang, category) values (${t.id}, ${a[1]!}, ${price}, ${a[3] ?? null})
        returning id`;
      console.log(r!.id);
      break;
    }
    case "set-confirm": {
      const t = await tenant(a[0]);
      await sql`update tenant set settings = jsonb_set(settings, '{require_confirm}', ${a[1] === "on" ? sql`'true'::jsonb` : sql`'false'::jsonb`}) where id = ${t.id}`;
      console.log("ok");
      break;
    }
    case "set-setting": {
      const t = await tenant(a[0]);
      const allowed = ["require_confirm", "confirm_first_only", "pos_forward", "order_token", "require_open", "order_cooldown_sec", "max_orders_per_bill", "max_devices_per_bill"];
      if (!allowed.includes(a[1] ?? "")) throw new Error(`key must be one of: ${allowed.join(", ")}`);
      const v = a[2] === "true" ? true : a[2] === "false" ? false : Number(a[2]);
      if (typeof v === "number" && !Number.isFinite(v)) throw new Error("bad value");
      await sql`update tenant set settings = jsonb_set(settings, ${"{" + a[1] + "}"}::text[], ${sql.json(v)}) where id = ${t.id}`;
      console.log("ok");
      break;
    }
    case "set-pos-map": {
      const t = await tenant(a[0]);
      if (a[1] === "table") await sql`update dining_table set pos_table_id = ${a[3]!} where tenant_id = ${t.id} and label = ${a[2]!}`;
      else if (a[1] === "menu") await sql`update menu_item set pos_product_id = ${a[3]!} where tenant_id = ${t.id} and name = ${a[2]!}`;
      else throw new Error("use: set-pos-map <slug> table|menu <name> <id>");
      console.log("ok");
      break;
    }
    case "set-reset": {
      const t = await tenant(a[0]);
      if (a[1] === "off") {
        await sql`update tenant set reset_enabled = false where id = ${t.id}`;
      } else {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(a[1] ?? "")) throw new Error("time must be HH:MM");
        const tz = a[2] ?? "Asia/Bangkok";
        const [ok] = await sql`select 1 as ok from pg_timezone_names where name = ${tz}`;
        if (!ok) throw new Error(`unknown tz: ${tz}`);
        await sql`update tenant set reset_enabled = true, reset_time = ${a[1]!}::time, tz = ${tz} where id = ${t.id}`;
      }
      console.log("ok");
      break;
    }
    default:
      console.log("commands: create-tenant | add-table | print-urls | rotate-qr | add-staff | add-menu | set-confirm | set-setting | set-pos-map | set-reset");
  }
} finally {
  await sql.end();
}
