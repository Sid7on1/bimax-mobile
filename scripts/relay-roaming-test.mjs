// Isolated synthetic devices only. No real account, paired profile, model or project is used.
import {createRequire} from 'node:module';import {Buffer} from 'node:buffer';
import {execFileSync,spawn} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';import assert from 'node:assert/strict';import {SignJWT} from 'jose';
const require=createRequire(import.meta.url),WebSocket=require('ws');
const {Responder,createIdentity}=require('../apps/desktop-responder/dist/index.js');
const {FakeEngine}=require('../apps/desktop-responder/dist/fake-engine.js');
const {PairingManager}=require('@bimax/core/session/session');
const {buildTransportConfirmation}=require('@bimax/core/session/lifecycle');
const {generateEd25519Keypair,generateX25519Keypair,ed25519Sign}=require('@bimax/core/crypto/keys');
const {seal,open,newE2EState}=require('@bimax/core/e2e/framing');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bimax-roaming-'));let relay,phone,mac;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async check=>{const until=Date.now()+15000;while(!check()){if(Date.now()>until)throw Error('Roaming end state deadline');await sleep(20);}};
try{
 fs.symlinkSync(path.resolve('node_modules'),path.join(temp,'node_modules'),'dir');
 execFileSync(process.execPath,['node_modules/typescript/bin/tsc','apps/mobile/lib/relay/client.ts','apps/mobile/lib/session/history-client.ts','apps/mobile/lib/session/live-client.ts','--outDir',path.join(temp,'phone'),'--module','commonjs','--target','es2022','--moduleResolution','node','--strict','--esModuleInterop','--skipLibCheck'],{stdio:'pipe'});
 const {RelayClient}=require(path.join(temp,'phone/relay/client.js'));
 const {HistoryClient}=require(path.join(temp,'phone/session/history-client.js'));
 const {LiveConversationClient}=require(path.join(temp,'phone/session/live-client.js'));
 relay=spawn(process.execPath,['apps/relay/dist/index.js'],{env:{...process.env,PORT:'0',RELAY_HOST:'127.0.0.1',RELAY_ADMISSION_TOKEN:'',DB_PATH:path.join(temp,'relay.db')},stdio:['ignore','ignore','ignore','ipc']});
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Local relay deadline')),10000);relay.on('message',m=>{if(m.type==='relay-listening'){clearTimeout(timer);resolve(m.port);}});relay.on('error',reject);});
 const lan=`ws://127.0.0.1:${port}`,identity=createIdentity('fixture-mac-'+randomUUID()),phoneId='fixture-phone-'+randomUUID(),phoneEd=generateEd25519Keypair(),phoneX=generateX25519Keypair();
 const engine=new FakeEngine();let changed,revision=1,streaming='';engine.onSessionChanged=f=>{changed=f;return()=>{changed=undefined;};};engine.getSessionHistory=async id=>({sessionId:id,title:'Fixture only',status:'idle',messages:[{id:'saved',role:'assistant',content:'Saved fixture α '.repeat(15000)}],streaming,thinking:'',updatedAt:1,revision});
 let promptCount=0;mac=new Responder({identity,enginePort:engine,relayUrl:lan,dataDir:path.join(temp,'mac'),hostControls:{setRemoteSessionActive:async()=>{},authorize:async()=>{promptCount++;return true;}}});await mac.start();
 let session,frameState=newE2EState();const grants=[],errors=[],snapshots=[];const history=new HistoryClient(),live=new LiveConversationClient(history);
 const onMessage=env=>{if(env.kind==='pairing_grant')grants.push(env);if(env.kind==='encrypted'&&session){try{const result=open(session,frameState,{id:env.id,from:env.from,to:env.to,kind:env.kind,ciphertextB64:env.payload.ciphertext});if(result.duplicate)return;const b=result.body;if(result.innerKind==='session_watch_status')live.status(b);if(result.innerKind==='session_history_chunk')history.handle(b);if(result.innerKind==='session_update')live.update(b);}catch(e){errors.push(e.message);}}};
 function connect(url,authorizeUrl){phone?.close();phone=new RelayClient({url,authorizeUrl,deviceId:phoneId,role:'mobile',wsImpl:WebSocket,helloSigner:{pubkeyB64:Buffer.from(phoneEd.publicKey).toString('base64'),sign:async bytes=>ed25519Sign(phoneEd.privateKey,bytes)},onMessage});phone.connect();}
 async function handshake(first){const manager=new PairingManager({deviceId:phoneId,staticKeypair:phoneX,helloKeypair:phoneEd});phone.send(manager.beginPairing({...mac.pairingManager.getAdvertisement(),ref:first?mac.pairingManager.getAdvertisement().ref:'rehandshake'}));await wait(()=>grants.length);session=manager.handleGrant(grants.shift());frameState=newE2EState();phone.send(buildTransportConfirmation(session,phoneId));await sleep(150);if(first)await mac.confirmTrustedPhone(mac.pairingManager.getCandidatePairing().verificationCode);}
 function send(kind,body){const outer={id:randomUUID(),from:phoneId,to:identity.deviceId};phone.send({v:2,...outer,ts:Date.now(),kind:'encrypted',payload:{ciphertext:seal(session,frameState,kind,body,outer)}});}
 connect(lan);await wait(()=>phone.status==='online'&&mac.relayClient.status==='online');await handshake(true);
 let close=live.watch('session-fake-1',send,s=>snapshots.push(s),e=>errors.push(e.message));await wait(()=>snapshots.length===1);assert.equal(snapshots[0].messages[0].content.length,'Saved fixture α '.repeat(15000).length);close();
 const secretFile=process.env.BIMAX_PUBLIC_RELAY_SECRET_FILE;
 if(!secretFile)throw Error('Set BIMAX_PUBLIC_RELAY_SECRET_FILE for the owned relay fixture');
 const secret=fs.readFileSync(secretFile,'utf8').trim(),room=createHash('sha256').update(identity.helloPubkeyB64).digest('hex'),cloud='wss://bimax-relay.sid7vish.workers.dev/room/'+room;
 const authorize=(deviceId,role,pub)=>async url=>{const ticket=await new SignJWT({roomId:room,deviceId,role,helloPubkey:pub}).setProtectedHeader({alg:'HS256'}).setIssuer('bimax-gateway').setAudience('bimax-relay').setSubject('isolated-roaming-fixture').setIssuedAt().setExpirationTime('60s').sign(new TextEncoder().encode(secret));return url+'?ticket='+ticket;};
 mac.connectCloud(cloud,authorize(identity.deviceId,'desktop',identity.helloPubkeyB64));connect(cloud,authorize(phoneId,'mobile',Buffer.from(phoneEd.publicKey).toString('base64')));
 await wait(()=>phone.status==='online'&&mac.cloudStatus==='online');await handshake(false);history.clear();live.clear();
 close=live.watch('session-fake-1',send,s=>snapshots.push(s),e=>errors.push(e.message));await wait(()=>snapshots.length===2);
 // Remove LAN entirely. Only the deployed encrypted cloud route can carry the next change.
 mac.relayClient.close();relay.kill('SIGTERM');await sleep(150);revision++;streaming='Live work started on the home Mac';changed('session-fake-1');await wait(()=>snapshots.at(-1)?.streaming===streaming);assert.equal(mac.phoneConnected,true);assert.equal(mac.cryptoFailureCount,0);assert.deepEqual(errors,[]);close();await mac.emergencyStop('isolated fixture');assert.equal(engine.killExecutionCount,1);await mac.stop();assert.equal(mac.pairingManager.getActiveSession(),null);assert.equal(mac.cloudStatus,'offline');assert.equal(mac.relayClient.status,'offline');
 console.log(JSON.stringify({checks:['large exact history survives relay limits','LAN human pairing fixture','deployed TLS ticket/signed hello','same trusted device reconnects on cloud without new human grant','LAN removed; Mac-origin live update arrives over encrypted cloud','selected baseline re-established on transport change','local Stop clears secure authority'],physicalPhone:false,accountRegistration:false,realEngine:false,cryptoFailures:0},null,2));
 live.clear();history.clear();void promptCount;
}finally{phone?.close();await mac?.stop();relay?.kill('SIGKILL');fs.rmSync(temp,{recursive:true,force:true});}
