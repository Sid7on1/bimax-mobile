/** Actual RN screens rendered through RN Web with inert account/relay fixtures. No production auth bypass. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const desktop = process.env.BIMAX_DESKTOP_ROOT || "/Users/vishsiddharth/Bimax";
const require = createRequire(path.join(desktop, "app/package.json"));
const { build } = require("esbuild");
const out = path.resolve(process.argv[2] || "/tmp/bimax-mobile-ui");
fs.mkdirSync(out, { recursive: true });
const mobile = path.resolve("apps/mobile");
const mocks = {
  router: `import {useEffect} from "react";const router={push:()=>{},replace:()=>{},back:()=>{}};export const useRouter=()=>router;export const useLocalSearchParams=()=>({id:'fixture'});export const useFocusEffect=fn=>useEffect(fn,[fn]);`,
  store: `export async function getConversation(){return null;} export async function createConversation(){return {id:'fixture',model:'openai/gpt-oss-20b',title:'New chat'};} export async function updateConversation(){} export async function listConversations(){return [];} export async function deleteConversation(){} export async function listMessages(){return [];} export async function addMessage(m){globalThis.fixtureSaved.push(m);}`,
  gateway: `export async function getUsage(){return null;} export async function streamChat(o){globalThis.fixtureRequests.push(o.messages);if(globalThis.fixtureMode==='failure')throw Error('Provider unavailable. Please retry.');await new Promise(r=>setTimeout(r,30));o.onDelta({content:'Here is a clear starting point.'});if(globalThis.fixtureMode==='stop'){await new Promise(r=>{if(o.signal.aborted)r();else o.signal.addEventListener('abort',r,{once:true});});return {fullContent:'Here is a clear starting point.',fullReasoning:'',stopped:true};}return {fullContent:'Here is a clear starting point.',fullReasoning:'',stopped:false};}`,
  attachments: `export const buildAttachmentPrompt=(s)=>s;export const pickDocument=async()=>null;`,
  keys: `let id=0;export const randomId=p=>p+(++id);`,
  account: `export const requireActiveAccount=()=> 'fixture-account';`,
  clipboard: `export const setStringAsync=async s=>{globalThis.fixtureClipboard=s;};`,
  expo: `export const isRunningInExpoGo=()=>true;`,
  browser: `export const maybeCompleteAuthSession=()=>{};export const openAuthSessionAsync=async()=>({type:'cancel'});`,
  auth: `export async function authServiceHealth(){return {ok:true};}export const signInWithBrowser=async()=>{};`,
  supabase: `export const supabase={auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:()=>({data:{authListener:{unsubscribe(){}},subscription:{unsubscribe(){}}}}),signOut:async()=>{},signInWithOtp:async()=>({error:null})}};`,
  relay: `const value={status:'idle',connectionError:'',trustedDesktop:null,sessions:[],pendingApprovals:[],remoteSessions:[],commandLog:[],requestSessionList(){},pairWithDesktop(){return new Promise(()=>{});},dropSession(){},refreshTrustedDesktop(){}};export const useRelayContext=()=>value;export const formatVerificationCode=s=>s;`,
  crypto: `export const parseAdvertisement=()=>({relayUrl:"ws://127.0.0.1:8787/room/fixture",desktopDeviceId:"fixture-mac",desktopPublicKey:"fixture",ref:"fixture",app:"bimax"});export const saveTrustedDesktop=async()=>{};`,
  camera: `import React from 'react';export const useCameraPermissions=()=>[{granted:false},()=>{}];export const CameraView=()=>null;`,
};
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{View}from'react-native';import Chat from '${mobile}/app/chat/[id].tsx';import Home from '${mobile}/app/index.tsx';import Login from '${mobile}/app/login.tsx';import Pair from '${mobile}/app/pair.tsx';import Remote from '${mobile}/app/remote.tsx';import Approvals from '${mobile}/app/approvals.tsx';import{Message}from '${mobile}/components/Message.tsx';import{Composer}from '${mobile}/components/Composer.tsx';globalThis.fixtureSaved=[];globalThis.fixtureRequests=[];globalThis.fixtureMode='failure';const screen=new URLSearchParams(location.search).get('screen');const C={home:Home,login:Login,pair:Pair,remote:Remote,approvals:Approvals}[screen]||Chat;createRoot(document.getElementById('root')).render(screen==='rich'?<View style={{flex:1,backgroundColor:'#171717',paddingTop:40}}><Message id='user' role='user' content='Help me plan a focused workday.'/><Message id='assistant' role='assistant' content={'## A little structure goes a long way\\nStart with your most important task, then leave room to reset.\\n\\n- One focused work block\\n- A short walk\\n- Time to review\\n\\n\x60\x60\x60js\\nconst focus = 45;\\n\x60\x60\x60'}/><View style={{flex:1}}/><Composer selectedModel='openai/gpt-oss-20b' onModelChange={()=>{}} onSend={()=>{}}/></View>:<C/>);`;
const deps = path.resolve("node_modules");
const mobileRequire = createRequire(path.join(mobile, "package.json"));
const reactDomDir = path.dirname(mobileRequire.resolve("react-dom/package.json"));
await build({
  stdin: { contents: entry, loader: "jsx", resolveDir: process.cwd() },
  bundle: true,
  platform: "browser",
  format: "iife",
  outfile: path.join(out, "ui.js"),
  define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' },
  alias: {
    "react-native": path.join(deps, "react-native-web"),
    react: path.join(deps, "react"),
    "react-dom": reactDomDir,
  },
  plugins: [
    {
      name: "inert-preview-boundaries",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          const id = args.path;
          let key;
          if (id === "expo-router") key = "router";
          else if (id === "expo") key = "expo";
          else if (id === "expo-web-browser") key = "browser";
          else if (id === "expo-camera") key = "camera";
          else if (id === "expo-clipboard") key = "clipboard";
          else if (/\/lib\/chat-store$/.test(id)) key = "store";
          else if (/\/lib\/gateway$/.test(id)) key = "gateway";
          else if (/\/lib\/attachments$/.test(id)) key = "attachments";
          else if (/\/crypto\/keys$/.test(id)) key = "keys";
          else if (/\/lib\/account-scope$/.test(id)) key = "account";
          else if (/\/lib\/supabase$/.test(id)) key = "supabase";
          else if (/\/lib\/auth-flow$/.test(id)) key = "auth";
          else if (/\/lib\/session(?:\/provider)?$/.test(id)) key = "relay";
          else if (/\/lib\/crypto$/.test(id)) key = "crypto";
          if (key) return { path: key, namespace: "preview-fixture" };
        });
        b.onLoad({ filter: /.*/, namespace: "preview-fixture" }, (args) => ({
          contents: mocks[args.path],
          loader: "jsx",
        }));
      },
    },
  ],
});
fs.writeFileSync(
  path.join(out, "index.html"),
  `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0;background:#171717;color:#f3f3f3}#root{display:flex;flex-direction:column}*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif}</style><div id="root"></div><script src="ui.js"></script>`,
);
console.log("Rendered-source fixture built:", out);
