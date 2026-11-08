import postgres from 'postgres';
const sql=postgres(process.env.DATABASE_URL!,{max:1});
await sql`CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
const glob=new Bun.Glob('*.sql');
for (const file of [...glob.scanSync('db/migrations')].sort()) {
 const done=await sql`SELECT 1 FROM schema_migrations WHERE name=${file}`;
 if(done.length) continue;
 const content=await Bun.file(`db/migrations/${file}`).text();
 await sql.begin(async tx=>{
   await tx.unsafe(content);
   await tx`INSERT INTO schema_migrations(name) VALUES (${file})`;
 });
 console.log('Applied',file);
}
await sql.end();
