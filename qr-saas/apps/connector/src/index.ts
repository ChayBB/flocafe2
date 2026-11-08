// FloCafe adapter boundary: implement verified local POS integration before use.
// Never ACK a cloud event before the POS durably accepts it.
const base=process.env.API_BASE_URL!,token=process.env.CONNECTOR_TOKEN!;
if(!base||!token)throw Error('missing connector settings');
const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
async function sendToFloCafe(event:{id:string;kind:string;payload:unknown}):Promise<boolean>{
 console.warn('FloCafe adapter not implemented; event NOT acknowledged',event.id);
 return false;
}
while(true){
 try{
  const response=await fetch(`${base}/api/v1/connectors/events`,{headers});
  if(!response.ok)throw Error(`poll failed ${response.status}`);
  const data=await response.json() as {events:Array<{id:string;kind:string;payload:unknown}>};
  for(const event of data.events){
   if(await sendToFloCafe(event)){
    const ack=await fetch(`${base}/api/v1/connectors/ack`,{method:'POST',headers,body:JSON.stringify({event_id:event.id})});
    if(!ack.ok)throw Error(`ack failed ${ack.status}`);
   }
  }
 }catch(e){console.error('connector',e)}
 await Bun.sleep(3000);
}
