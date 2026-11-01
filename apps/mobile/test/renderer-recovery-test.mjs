import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
const require=createRequire(import.meta.url),ts=require('typescript');
function load(name,deps={}){const module={exports:{}};runInNewContext(ts.transpileModule(readFileSync(path.resolve(process.env.BIMAX_RECOVERY_SOURCE_ROOT||'apps/mobile/lib',name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:key=>deps[key],Date,Promise,JSON,TextEncoder,setTimeout,clearTimeout});return module.exports;}
const {RendererRecovery}=load('renderer/recovery');
test('one content-process death causes one remount despite duplicate/stale native events',()=>{const r=new RendererRecovery(()=>100);assert.equal(r.fail(0,'content-process-ended'),true);assert.equal(r.generation,1);assert.equal(r.fail(0,'render-process-ended'),false);assert.equal(r.generation,1);assert.equal(r.events.length,1);});
test('two automatic remounts per minute; a persistent fault stops instead of looping',()=>{let now=100;const r=new RendererRecovery(()=>now);assert(r.fail(0,'load-failed'));assert(r.fail(1,'ready-timeout'));assert.equal(r.fail(2,'content-process-ended'),false);assert.equal(r.generation,2);now+=60_001;assert.equal(r.fail(2,'load-failed'),false);assert.equal(r.retry(),3);assert(r.fail(3,'load-failed'));});
test('event ring contains only bounded event codes/times, and explicit retry renews the budget',()=>{let now=0;const r=new RendererRecovery(()=>now);for(let i=0;i<60;i++){r.retry();r.fail(r.generation,'content-process-ended');now++;}assert.equal(r.events.length,32);assert.deepEqual(Object.keys(r.events[0]).sort(),['at','code']);});
test('a synchronous incoming callback failure cannot escape the socket, and is never acknowledged',async()=>{
 const {RelayClient}=load('relay/client',{'../relay/url':{validateRelayUrl:()=>{}},'../crypto/keys':{canonicalJson:JSON.stringify,randomId:()=> 'fixture-id'},'../crypto/base64':{bytesToBase64:()=>''}});
 let socket,fail=true,processed=0;
 class Socket{listeners=new Map();sent=[];constructor(){socket=this;}addEventListener(k,f){this.listeners.set(k,f);}removeEventListener(k){this.listeners.delete(k);}send(s){this.sent.push(JSON.parse(s));}close(){}emit(k,data){return this.listeners.get(k)?.(data);}}
 const client=new RelayClient({url:'ws://127.0.0.1:8787',deviceId:'phone',role:'mobile',wsImpl:Socket,onMessage:()=>{if(fail)throw Error('inert processing failure');processed++;}});
 client.connect();await Promise.resolve();await socket.emit('open');const event={data:JSON.stringify({id:'fixture-envelope',kind:'opaque'})};
 assert.doesNotThrow(()=>socket.emit('message',event));await new Promise(resolve=>setTimeout(resolve,0));assert.equal(socket.sent.filter(s=>s.kind==='delivery_ack').length,0);
 fail=false;socket.emit('message',event);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(processed,1);assert.equal(socket.sent.filter(s=>s.kind==='delivery_ack').length,1);client.close();
});
