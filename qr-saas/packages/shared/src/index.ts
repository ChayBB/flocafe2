import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
export const sha256=(s:string)=>createHash('sha256').update(s).digest('hex');
export const token=()=>randomBytes(32).toString('base64url');
export function constantEqual(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)}
export function bearer(request:Request){return request.headers.get('authorization')?.replace(/^Bearer /i,'')??''}
