import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const require = createRequire(import.meta.url), ts = require("typescript");
const load = (name, dependencies = {}) => {
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(path.join(process.env.BIMAX_PREFERENCES_ROOT || fileURLToPath(new URL("../lib", import.meta.url)), `${name}.ts`), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { module, exports: module.exports, require: key => dependencies[key], Object, JSON });
  return module.exports;
};
const { PreferenceStore, parsePreferences } = load("preferences");
const defaults = { textSize: "comfortable", reduceMotion: false, showThinking: true, followReplies: true };
const plain = v => JSON.parse(JSON.stringify(v));
const defer = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b; }); return { promise, resolve, reject }; };
test("missing/corrupt/foreign preference data retains valid explicit boolean defaults", () => {
  for (const raw of [null, "bad", "[]", "null", "true"]) assert.deepEqual(plain(parsePreferences(raw)), defaults);
  assert.deepEqual(plain(parsePreferences('{"reduceMotion":"false","showThinking":false,"followReplies":0,"foreign":true}')), {...defaults, showThinking:false});
});
test("toggles cannot race a slow initial read; a disposed account cannot publish late data", async () => {
  const read=defer(), changes=[], writes=[];
  const store=new PreferenceStore({read:()=>read.promise,write:async raw=>writes.push(raw)},s=>changes.push(s));
  const loading=store.load();await store.set("showThinking",false);assert.equal(writes.length,0);
  store.dispose();read.resolve('{"reduceMotion":true}');await loading;assert.equal(changes.length,0);
});
test("rapid toggles serialize native writes and persist the exact final snapshot", async () => {
  let stored=null, active=0, maxActive=0;const gates=[],states=[];
  const store=new PreferenceStore({read:async()=>null,write:async raw=>{active++;maxActive=Math.max(active,maxActive);const gate=defer();gates.push(gate);await gate.promise;stored=raw;active--;}},s=>states.push(s));
  await store.load();const first=store.set("showThinking",false), second=store.set("followReplies",false), third=store.set("showThinking",true);
  for(let i=0;i<3;i++){while(gates.length<=i)await Promise.resolve();gates[i].resolve();}
  await Promise.all([first,second,third]);assert.equal(maxActive,1);assert.deepEqual(JSON.parse(stored),{...defaults,followReplies:false});assert.equal(states.at(-1).error,null);
});
test("storage errors are visible, changes still apply, and the next successful write recovers", async () => {
  let fail=true;const store=new PreferenceStore({read:async()=>{throw Error("locked");},write:async()=>{if(fail)throw Error("full");}},()=>{});
  await store.load();assert.match(store.snapshot.error,/load/);await store.set("reduceMotion",true);assert.equal(store.snapshot.preferences.reduceMotion,true);assert.match(store.snapshot.error,/save/);
  fail=false;await store.set("showThinking",false);assert.equal(store.snapshot.error,null);
});
test("sign-out cancels queued writes and a late completion cannot notify a new account", async () => {
  const gate=defer(),writes=[],states=[];const store=new PreferenceStore({read:async()=>null,write:async raw=>{writes.push(raw);await gate.promise;}},s=>states.push(s));await store.load();
  const a=store.set("reduceMotion",true),b=store.set("showThinking",false);await Promise.resolve();store.dispose();const count=states.length;gate.resolve();await Promise.all([a,b]);assert.equal(writes.length,1);assert.equal(states.length,count);
});
const { transcriptOperation, wireState } = load("renderer/bridge", {"../../generated/chat-renderer.json":{}});
const { TranscriptDelivery } = load("renderer/delivery", {"./bridge":{transcriptOperation}});
const state = (text,key="chat") => ({key,messages:[{id:"reply",role:"assistant",content:text,streaming:true}]});
const clock = () => {const frames=new Map();let serial=0;return {schedule:run=>{frames.set(++serial,run);return serial;},cancel:id=>frames.delete(id),tick:()=>{for(const [id,run] of [...frames]){frames.delete(id);run();}},frames};};
test("100 streamed updates make one bridge write with exact final Unicode bytes", () => {
  const c=clock(),sent=[],delivery=new TranscriptDelivery(op=>sent.push(op),c.schedule,c.cancel);
  for(let i=1;i<=100;i++)delivery.push(state("α".repeat(i)));assert.equal(c.frames.size,1);c.tick();assert.equal(sent.length,1);assert.equal(sent[0].state.messages[0].content,"α".repeat(100));
  delivery.push(state("α".repeat(100)));c.tick();assert.equal(sent.length,1);
  delivery.push(state("α".repeat(100)+"終"));c.tick();assert.equal(sent[1].type,"patch");assert.equal(sent[1].patch.content.append,"終");
});
test("changing chats or resetting the WebView sends a full fresh state and cancels old frames", () => {
  const c=clock(),sent=[],d=new TranscriptDelivery(op=>sent.push(op),c.schedule,c.cancel);
  d.push(state("old"));d.push(state("new","other"));c.tick();assert.equal(sent[0].state.key,"other");
  d.push(state("stale"));d.reset();c.tick();assert.equal(sent.length,1);d.push(state("fresh","other"));c.tick();assert.equal(sent[1].type,"update");
  d.push(state("late"));d.dispose();d.push(state("later"));c.tick();assert.equal(sent.length,2);
});
test("preference-only and failed-message changes survive no-op suppression; callbacks never cross", () => {
  const prev=state("answer"), next={...prev,preferences:{reduceMotion:true,showThinking:false,followReplies:false},failedId:"reply"};
  assert.equal(transcriptOperation(prev,prev),null);const preferenceOnly=transcriptOperation(prev,{...next,failedId:undefined});assert.ok(preferenceOnly);assert.equal(preferenceOnly.patch.preferences.reduceMotion,true);const patch=transcriptOperation(prev,next);assert.equal(patch.patch.preferences.reduceMotion,true);assert.equal(patch.patch.failedId,"reply");
  assert.equal("onRetry" in wireState({conversationKey:"chat",messages:[],onRetry:()=>{}}),false);
});

test("chat text size accepts only supported choices and persists alongside boolean controls", async () => {
 let saved;const store=new PreferenceStore({read:async()=>'{"textSize":"unbounded"}',write:async raw=>saved=raw},()=>{});await store.load();assert.equal(store.snapshot.preferences.textSize,"comfortable");await store.set("textSize","large");assert.equal(JSON.parse(saved).textSize,"large");await store.set("textSize",123);assert.equal(store.snapshot.preferences.textSize,"large");
});
