import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve("apps/mobile/lib"), test = path.resolve("apps/mobile/test/preferences-test.mjs");
const cases = [
  ["corrupt preference booleans accepted", "preferences.ts", 'typeof value[key] === "boolean"', 'value[key] !== undefined'],
  ["parallel native saves can reorder settings", "preferences.ts", 'this.writes.then(async () => {', 'Promise.resolve().then(async () => {'],
  ["late account loads publish after dispose", "preferences.ts", 'if (this.active) {', 'if (true) {'],
  ["streaming burst sends first state instead of latest", "renderer/delivery.ts", 'this.pending = state;', 'this.pending ??= state;'],
  ["preference-only patches suppressed as unchanged", "renderer/bridge.ts", 'JSON.stringify(previous.preferences) === JSON.stringify(next.preferences)', 'true'],
];
const results=[];
for(const [name,file,before,after] of cases) {
 const scratch=mkdtempSync(path.join(tmpdir(),"bimax-pref-mutation-"));
 try {
  mkdirSync(path.join(scratch,"renderer"));
  for(const source of ["preferences.ts","renderer/bridge.ts","renderer/delivery.ts"])writeFileSync(path.join(scratch,source),readFileSync(path.join(root,source)));
  const source=readFileSync(path.join(scratch,file),"utf8");assert.ok(source.includes(before),`Mutation anchor missing: ${name}`);
  writeFileSync(path.join(scratch,file),source.replace(before,after));
  const run=spawnSync(process.execPath,[test],{encoding:"utf8",timeout:10000,env:{...process.env,BIMAX_PREFERENCES_ROOT:scratch}});
  const output=(run.stdout||"")+(run.stderr||"");
  assert.ok(run.status!==0 && /AssertionError/.test(output),`Mutation not caught by assertion: ${name}\n${output}`);
  results.push({name,caught:true});
 }finally{rmSync(scratch,{recursive:true,force:true});}
}
console.log(JSON.stringify({caught:results.length,results},null,2));
