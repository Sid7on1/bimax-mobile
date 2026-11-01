import {sha256Hex} from '../../gateway/src/auth';
import type {Env} from '../../gateway/src/auth';
import {mintTransportTicket,removeRelayRoom} from '../../gateway/src/relay-ticket';
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
async function checkProof(pub:string,body:Record<string,unknown>,deviceId:string,action:string,credential?:string){
 const {at,nonce,signature}=body;
 if(body.action!==action||typeof nonce!=='string'||!/^[a-f0-9]{32}$/.test(nonce)||!Number.isSafeInteger(at)||Math.abs(Date.now()-Number(at))>60000||typeof signature!=='string'||signature.length>100||typeof body.roomId!=='string'||!/^[a-f0-9]{64}$/.test(body.roomId))throw Error('Invalid device proof');
 const payload=action==='register'?{action,at,deviceId,helloPubkey:pub,nonce,roomId:body.roomId}:{action,at,credential,deviceId,nonce,roomId:body.roomId};
 const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(pub),c=>c.charCodeAt(0)),'Ed25519',false,['verify']);
 if(!await crypto.subtle.verify('Ed25519',key,Uint8Array.from(atob(signature),c=>c.charCodeAt(0)),new TextEncoder().encode(JSON.stringify(payload))))throw Error('Device proof rejected');
}
/** A signed-in phone registers its verified Mac key. The grant can only renew/revoke that room. */
export async function registerRelayDevice(env:Env,userId:string,body:Record<string,unknown>){
 const {deviceId,helloPubkey}=body;
 if(!id(deviceId)||typeof helloPubkey!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(helloPubkey))throw Error('Invalid paired device');
 const roomId=await sha256Hex(helloPubkey);if(body.roomId!==roomId)throw Error('Room must be bound to the Mac key');
 await checkProof(helloPubkey,body,deviceId,'register');
 const url=new URL(env.RELAY_PUBLIC_URL??'');if(url.protocol!=='wss:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Cloud relay unavailable');url.pathname='/room/'+roomId;
 await env.DB.prepare('INSERT OR IGNORE INTO relay_rooms(room_id,user_id,updated_at) SELECT ?1,?2,?3 WHERE (SELECT COUNT(*) FROM relay_rooms WHERE user_id=?2)<5').bind(roomId,userId,new Date().toISOString()).run();
 await mintTransportTicket(env,userId,{roomId,deviceId,helloPubkey,role:'desktop'});
 await env.DB.prepare('UPDATE relay_devices SET renewal_id=COALESCE(renewal_id,?) WHERE room_id=? AND device_id=? AND hello_pubkey=?').bind('rd_'+crypto.randomUUID(),roomId,deviceId,helloPubkey).run();
 const row=await env.DB.prepare('SELECT renewal_id FROM relay_devices WHERE room_id=? AND device_id=?').bind(roomId,deviceId).first<{renewal_id:string}>();
 if(!row?.renewal_id)throw Error('Device grant unavailable');
 return {relayUrl:url.href,credential:row.renewal_id,deviceId};
}
export async function verifyRelayDevice(env:Env,credential:string,body:Record<string,unknown>){
 if(!/^rd_[a-f0-9-]{36}$/.test(credential)||!id(body.deviceId)||typeof body.roomId!=='string'||!/^[a-f0-9]{64}$/.test(body.roomId)||!['renew','revoke'].includes(String(body.action)))throw Error('Invalid device grant');
 const owner=await env.DB.prepare('SELECT user_id FROM relay_rooms WHERE room_id=?').bind(body.roomId).first<{user_id:string}>();
 const device=await env.DB.prepare('SELECT hello_pubkey,renewal_id FROM relay_devices WHERE room_id=? AND device_id=?').bind(body.roomId,body.deviceId).first<{hello_pubkey:string;renewal_id:string}>();
 if(!owner||device?.renewal_id!==credential)throw Error('Device grant revoked');
 await checkProof(device.hello_pubkey,body,body.deviceId,String(body.action),credential);
 return {userId:owner.user_id,deviceId:body.deviceId,helloPubkey:device.hello_pubkey,roomId:body.roomId,action:body.action};
}
export async function renewRelayDevice(env:Env,credential:string,body:Record<string,unknown>){
 const p=await verifyRelayDevice(env,credential,body);
 if(p.action==='revoke'){await removeRelayRoom(env,p.userId,p.roomId);return {revoked:true};}
 return {ticket:await mintTransportTicket(env,p.userId,{roomId:p.roomId,deviceId:p.deviceId,helloPubkey:p.helloPubkey,role:'desktop'})};
}
