import postgres from "postgres";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const url = process.env.ADMIN_DATABASE_URL;
if (!url) throw new Error("ADMIN_DATABASE_URL is required (role pos_migrate)");

const sql = postgres(url, { max: 1, onnotice: () => {} });
const dir = join(import.meta.dir, "..", "migrations");

await sql`create table if not exists schema_migration (name text primary key, applied_at timestamptz not null default now())`;
const done = new Set((await sql`select name from schema_migration`).map((r) => r.name as string));

for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  if (done.has(f)) continue;
  console.log("applying", f);
  await sql.begin(async (tx) => {
    await tx.unsafe(readFileSync(join(dir, f), "utf8"));
    await tx`insert into schema_migration (name) values (${f})`;
  });
}
console.log("migrations up to date");
await sql.end();
