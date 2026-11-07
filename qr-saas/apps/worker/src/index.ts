import postgres from 'postgres';
import Redis from 'ioredis';
const sql=postgres(process.env.DATABASE_URL!,{max:4});
const redis=new Redis(process.env.REDIS_URL!);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
console.log('Outbox worker started');
while(true){
 try{
  const batch=await sql.begin(async tx=>{
   const events=await tx`SELECT id,tenant_id,branch_id FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED`;
   for(const e of events){
    await tx`INSERT INTO connector_deliveries(event_id,tenant_id,branch_id) VALUES (${e.id},${e.tenant_id},${e.branch_id}) ON CONFLICT DO NOTHING`;
    await tx`UPDATE outbox_events SET published_at=now() WHERE id=${e.id}`;
   }
   return events;
  });
  if(batch.length)await redis.publish('qr:outbox',JSON.stringify({count:batch.length}));
 }catch(e){console.error('outbox worker error',e)}
 await sleep(1000);
}
