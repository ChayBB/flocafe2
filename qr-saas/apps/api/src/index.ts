import { Elysia, t } from 'elysia';
import postgres from 'postgres';
import Redis from 'ioredis';
import { bearer, constantEqual, sha256, token } from '../../../packages/shared/src/index';
const sql=postgres(process.env.DATABASE_URL!,{max:12});
const redis=new Redis(process.env.REDIS_URL!);
const adminSecret=process.env.ADMIN_BOOTSTRAP_TOKEN!;
const connectorSecret=process.env.CONNECTOR_TOKEN!;
if(!adminSecret||adminSecret.length<24||!connectorSecret||connectorSecret.length<24) throw Error('Configure strong secrets');
const err=(status:number,message:string)=>new Response(JSON.stringify({error:message}),{status,headers:{'content-type':'application/json'}});
const isAdmin=(r:Request)=>constantEqual(bearer(r),adminSecret);
const isConnector=(r:Request)=>constantEqual(bearer(r),connectorSecret);
const app=new Elysia()
.get('/health/live',()=>({ok:true}))
.get('/health/ready',async()=>{await sql`SELECT 1`;await redis.ping();return {ok:true}})
.post('/api/v1/admin/tenants',async({request,body})=>{
 if(!isAdmin(request))return err(401,'unauthorized');
 const [row]=await sql`INSERT INTO tenants(name) VALUES (${body.name}) RETURNING *`;return row;
},{body:t.Object({name:t.String({minLength:1,maxLength:100})})})
.post('/api/v1/admin/branches',async({request,body})=>{
 if(!isAdmin(request))return err(401,'unauthorized');
 const [row]=await sql`INSERT INTO branches(tenant_id,name) VALUES (${body.tenant_id},${body.name}) RETURNING *`;return row;
},{body:t.Object({tenant_id:t.String({format:'uuid'}),name:t.String({minLength:1,maxLength:100})})})
.post('/api/v1/admin/tables',async({request,body})=>{
 if(!isAdmin(request))return err(401,'unauthorized');
 const [row]=await sql`INSERT INTO dining_tables(tenant_id,branch_id,name) VALUES (${body.tenant_id},${body.branch_id},${body.name}) RETURNING *`;return row;
},{body:t.Object({tenant_id:t.String({format:'uuid'}),branch_id:t.String({format:'uuid'}),name:t.String({minLength:1,maxLength:80})})})
.post('/api/v1/admin/menu-items',async({request,body})=>{
 if(!isAdmin(request))return err(401,'unauthorized');
 const [row]=await sql`INSERT INTO menu_items(tenant_id,branch_id,external_id,name,price_satang) VALUES (${body.tenant_id},${body.branch_id},${body.external_id},${body.name},${body.price_satang}) ON CONFLICT(tenant_id,branch_id,external_id) DO UPDATE SET name=excluded.name,price_satang=excluded.price_satang,updated_at=now() RETURNING *`;return row;
},{body:t.Object({tenant_id:t.String({format:'uuid'}),branch_id:t.String({format:'uuid'}),external_id:t.String(),name:t.String(),price_satang:t.Integer({minimum:0})})})
.post('/api/v1/admin/table-sessions',async({request,body})=>{
 if(!isAdmin(request))return err(401,'unauthorized');
 const [table]=await sql`SELECT * FROM dining_tables WHERE id=${body.table_id} AND tenant_id=${body.tenant_id} AND branch_id=${body.branch_id}`;
 if(!table)return err(404,'table not found');
 const secret=token();
 const [row]=await sql`INSERT INTO table_sessions(tenant_id,branch_id,table_id,token_hash,expires_at) VALUES (${body.tenant_id},${body.branch_id},${body.table_id},${sha256(secret)},now()+interval '3 hours') RETURNING id,expires_at`;
 return {...row,table_token:secret};
},{body:t.Object({tenant_id:t.String({format:'uuid'}),branch_id:t.String({format:'uuid'}),table_id:t.String({format:'uuid'})})})
.get('/api/v1/menu',async({request})=>{
 const secret=bearer(request);if(!secret)return err(401,'missing session');
 const [session]=await sql`SELECT * FROM table_sessions WHERE token_hash=${sha256(secret)} AND expires_at>now() AND revoked_at IS NULL`;
 if(!session)return err(401,'invalid session');
 return {items:await sql`SELECT id,name,price_satang FROM menu_items WHERE tenant_id=${session.tenant_id} AND branch_id=${session.branch_id} AND available=true ORDER BY name`};
})
.post('/api/v1/orders',async({request,body})=>{
 const secret=bearer(request),key=request.headers.get('idempotency-key');
 if(!secret||!key||key.length>128)return err(400,'session and idempotency-key required');
 const [session]=await sql`SELECT * FROM table_sessions WHERE token_hash=${sha256(secret)} AND expires_at>now() AND revoked_at IS NULL`;
 if(!session)return err(401,'invalid session');
 const hash=sha256(JSON.stringify(body));
 try {
 return await sql.begin(async tx=>{
   // Lock session serializes requests within one table session, including key races.
   const [locked]=await tx`SELECT id FROM table_sessions WHERE id=${session.id} AND expires_at>now() AND revoked_at IS NULL FOR UPDATE`;
   if(!locked)throw Error('session expired');
   const [prior]=await tx`SELECT * FROM idempotency_records WHERE tenant_id=${session.tenant_id} AND branch_id=${session.branch_id} AND key=${key}`;
   if(prior){if(prior.request_hash!==hash)return err(409,'idempotency key reused with different payload');return {order_id:prior.order_id,replayed:true};}
   const ids=body.items.map(x=>x.menu_item_id);
   if(new Set(ids).size!==ids.length)return err(400,'duplicate item ids; consolidate quantities');
   const menu=await tx`SELECT id,name,price_satang FROM menu_items WHERE tenant_id=${session.tenant_id} AND branch_id=${session.branch_id} AND available=true AND id IN ${tx(ids)}`;
   if(menu.length!==ids.length)return err(400,'invalid menu item');
   const lines=body.items.map(x=>{const m=menu.find(y=>y.id===x.menu_item_id)!;return {...x,name:m.name,unit:m.price_satang,line:m.price_satang*x.quantity}});
   const total=lines.reduce((n,x)=>n+x.line,0);
   const [order]=await tx`INSERT INTO orders(tenant_id,branch_id,table_session_id,total_satang) VALUES (${session.tenant_id},${session.branch_id},${session.id},${total}) RETURNING id`;
   for(const x of lines)await tx`INSERT INTO order_items(order_id,menu_item_id,name_snapshot,unit_price_satang,quantity,line_total_satang,note) VALUES (${order.id},${x.menu_item_id},${x.name},${x.unit},${x.quantity},${x.line},${x.note??''})`;
   await tx`INSERT INTO idempotency_records(tenant_id,branch_id,key,request_hash,order_id) VALUES (${session.tenant_id},${session.branch_id},${key},${hash},${order.id})`;
   await tx`INSERT INTO outbox_events(tenant_id,branch_id,kind,payload) VALUES (${session.tenant_id},${session.branch_id},'order.created',${tx.json({order_id:order.id})})`;
   return {order_id:order.id,total_satang:total,status:'created',replayed:false};
 });
 }catch(e){console.error(e);return err(500,'order creation failed');}
},{body:t.Object({items:t.Array(t.Object({menu_item_id:t.String({format:'uuid'}),quantity:t.Integer({minimum:1,maximum:99}),note:t.Optional(t.String({maxLength:160}))}),{minItems:1,maxItems:30})})})
.get('/api/v1/orders/:id',async({request,params})=>{
 const secret=bearer(request);if(!secret)return err(401,'missing session');
 const [row]=await sql`SELECT o.id,o.status,o.total_satang,o.created_at FROM orders o JOIN table_sessions s ON s.id=o.table_session_id WHERE o.id=${params.id} AND s.token_hash=${sha256(secret)} AND s.expires_at>now() AND s.revoked_at IS NULL`;
 return row??err(404,'not found');
})
.get('/api/v1/connectors/events',async({request,query})=>{
 if(!isConnector(request))return err(401,'unauthorized');
 const tenant=process.env.CONNECTOR_TENANT_ID!,branch=process.env.CONNECTOR_BRANCH_ID!;
 return {events:await sql`SELECT e.id,e.kind,e.payload,e.created_at FROM outbox_events e JOIN connector_deliveries d ON d.event_id=e.id WHERE e.tenant_id=${tenant} AND e.branch_id=${branch} AND d.status='pending' ORDER BY e.created_at LIMIT 30`};
})
.post('/api/v1/connectors/ack',async({request,body})=>{
 if(!isConnector(request))return err(401,'unauthorized');
 const tenant=process.env.CONNECTOR_TENANT_ID!,branch=process.env.CONNECTOR_BRANCH_ID!;
 const rows=await sql`UPDATE connector_deliveries SET status='acknowledged',acknowledged_at=now() WHERE event_id=${body.event_id} AND tenant_id=${tenant} AND branch_id=${branch} AND status='pending' RETURNING event_id`;
 if(!rows.length)return err(404,'event not found or already acknowledged');
 const [evt]=await sql`SELECT payload FROM outbox_events WHERE id=${body.event_id}`;
 if(evt?.payload?.order_id)await sql`UPDATE orders SET status='pos_accepted' WHERE id=${evt.payload.order_id} AND tenant_id=${tenant} AND branch_id=${branch} AND status IN ('created','sent_to_pos')`;
 return {ok:true};
},{body:t.Object({event_id:t.String({format:'uuid'})})})
.post('/api/v1/admin/payments/cash-confirm',async({request,body})=>{
 if(!isAdmin(request))return err(401,'unauthorized');
 // Bootstrap-only: replace with branch-scoped staff RBAC before production.
 const [o]=await sql`SELECT id,tenant_id,branch_id,total_satang FROM orders WHERE id=${body.order_id}`;
 if(!o)return err(404,'order not found');
 const [p]=await sql`INSERT INTO payments(tenant_id,branch_id,order_id,method,status,amount_satang,confirmed_at) VALUES (${o.tenant_id},${o.branch_id},${o.id},'cash','confirmed',${o.total_satang},now()) RETURNING id,status`;
 await sql`INSERT INTO audit_logs(tenant_id,branch_id,actor,action,resource_id) VALUES (${o.tenant_id},${o.branch_id},'bootstrap-admin','cash.confirmed',${p.id})`;
 return p;
},{body:t.Object({order_id:t.String({format:'uuid'})})})
.listen({hostname:'0.0.0.0',port:Number(process.env.PORT??3000)});
console.log('QR API listening',app.server?.port);
