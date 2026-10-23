const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const ts = require(root + '/node_modules/typescript');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, file);
const local = p => require(path.join(root,p));
async function main() {
  const {createTestEnv} = local('apps/gateway/test/mocks.ts');
  const {checkRateLimit} = local('apps/gateway/src/ratelimit.ts');
  const {checkQuota} = local('apps/gateway/src/quota.ts');
  const {verifyAuth} = local('apps/gateway/src/auth.ts');
  const {env,mockRatelimitKV} = createTestEnv({RATE_LIMIT_PER_MIN:'30'});
  const limits = await Promise.all(Array.from({length:100},()=>checkRateLimit('same-user',env)));
  console.log('RATE_LIMIT_CONCURRENCY', JSON.stringify({allowed:limits.filter(x=>x.allowed).length,limit:30,storedCounter:[...mockRatelimitKV.store.values()][0].value}));
  const quota = createTestEnv({DEFAULT_MONTHLY_TOKENS:'100'});
  const checks = await Promise.all(Array.from({length:100},()=>checkQuota(quota.env.DB,'same-user',quota.env)));
  console.log('QUOTA_NO_RESERVATION', JSON.stringify({admitted:checks.filter(x=>x.allowed).length,budget:100,chargedIfEachUses15Tokens:1500}));
  console.log('MISSING_ENTITLEMENT', JSON.stringify(await checkQuota(quota.env.DB,'brand-new-user',quota.env)));
  const jose = require(root + '/node_modules/jose');
  const pair = await jose.generateKeyPair('RS256');
  const jwk = await jose.exportJWK(pair.publicKey);
  const token = await new jose.SignJWT({sub:'audit-user',iss:'unexpected-issuer',aud:'unexpected-audience'}).setProtectedHeader({alg:'RS256'}).sign(pair.privateKey);
  const accepted = await verifyAuth(new Request('https://audit.invalid',{headers:{Authorization:'Bearer '+token}}), {...env,TEST_JWKS:{keys:[jwk]}});
  console.log('JWT_WRONG_ISSUER_AUDIENCE_MISSING_EXP',JSON.stringify({accepted:!!accepted,userId:accepted?.userId}));
  const {IdempotencyLog} = local('apps/desktop-responder/src/idempotency.ts');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'bimax-audit-'));
  try {
    const file = path.join(temp,'idempotency.json');
    let calls = 0;
    const oldLog = new IdempotencyLog({storagePath:file});
    await oldLog.init();
    await oldLog.execute('completed-before-crash',async()=>++calls);
    const newLog = new IdempotencyLog({storagePath:file});
    await newLog.init();
    await newLog.execute('completed-before-crash',async()=>++calls);
    console.log('CRASH_BEFORE_BACKGROUND_PERSIST',JSON.stringify({effectExecutions:calls}));
    await oldLog.persistNow(); await newLog.persistNow();
    let release;
    const hanging = oldLog.execute('in-flight-at-crash',()=>new Promise(r=>release=r));
    await oldLog.persistNow();
    const afterCrash = new IdempotencyLog({storagePath:file});
    await afterCrash.init();
    console.log('IN_FLIGHT_RECORD_AFTER_RESTART',JSON.stringify({present:!!afterCrash.get('in-flight-at-crash')}));
    release('ok'); await hanging; await oldLog.persistNow();
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
  const {NoiseIKInitiator,NoiseIKResponder} = local('apps/mobile/lib/crypto/noise.ts');
  const {generateX25519Keypair} = local('apps/mobile/lib/crypto/keys.ts');
  const ik = generateX25519Keypair(), rk = generateX25519Keypair();
  const init = new NoiseIKInitiator({staticKeypair:ik,remoteStaticPublicKey:rk.publicKey});
  const resp = new NoiseIKResponder({staticKeypair:rk});
  resp.readMessage1(init.writeMessage1(new Uint8Array()));
  init.readMessage2(resp.writeMessage2(new Uint8Array()));
  init.encrypt(new TextEncoder().encode('lost packet'));
  const next = init.encrypt(new TextEncoder().encode('next packet'));
  try {resp.decrypt(next); console.log('DROPPED_FRAME_NEXT_DECRYPT','accepted');}
  catch {console.log('DROPPED_FRAME_NEXT_DECRYPT','authentication failure');}
  const providerPath = path.join(root,'apps/mobile/lib/session/provider.tsx');
  const source = ts.createSourceFile(providerPath,fs.readFileSync(providerPath,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let callback;
  function visit(node) {if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='handleIncoming')callback=node.initializer.arguments[0].getText(source); ts.forEachChild(node,visit);}
  visit(source);
  const observations = {};
  const approvals = local('apps/mobile/lib/approvals/approvals.ts'); approvals.clearApprovals();
  const injected = {addApproval:approvals.addApproval,getPending:approvals.getPending,setPendingApprovals:x=>observations.pending=x,setAgentStatus:x=>observations.status=x,setRemoteSessions:x=>observations.sessions=x,setCommandLog:()=>{},setLastKillAck:x=>observations.kill=x};
  const callbackJs = ts.transpileModule('const callback = '+callback+';', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const incoming = new Function(...Object.keys(injected),callbackJs+';return callback;')(...Object.values(injected));
  incoming({v:1,id:'forged-status',from:'untrusted-attacker',to:'phone',kind:'agent_status',payload:{state:'idle',taskSummary:'attacker-controlled',updatedAt:Date.now()}});
  incoming({v:1,id:'forged-approval',from:'untrusted-attacker',to:'phone',kind:'approval_request',payload:{approvalId:'audit-forged-approval',sessionId:'audit-session',tool:'shell',summary:'attacker-controlled',detail:'arbitrary prompt',requestedAt:Date.now(),expiresAt:Date.now()+60000}});
  console.log('PLAINTEXT_APP_MESSAGE_HANDLERS',JSON.stringify({statusAccepted:observations.status?.taskSummary==='attacker-controlled',approvalAccepted:observations.pending?.some(x=>x.approvalId==='audit-forged-approval')}));
  approvals.clearApprovals();
  const standardResp = new NoiseIKResponder({staticKeypair:rk});
  const originalInit = standardResp.initializeSymmetric.bind(standardResp);
  standardResp.initializeSymmetric = function() {originalInit(); this.mixHash(new Uint8Array());};
  const defaultInit = new NoiseIKInitiator({staticKeypair:ik,remoteStaticPublicKey:rk.publicKey});
  try {standardResp.readMessage1(defaultInit.writeMessage1(new Uint8Array())); console.log('EMPTY_PROLOGUE_SPEC_INTEROP','accepted');}
  catch {console.log('EMPTY_PROLOGUE_SPEC_INTEROP','authentication failure when responder follows required MixHash(empty)');}
  await reproducePairing();
}
async function reproducePairing() {
  const {spawn} = require('node:child_process');
  const {Responder} = local('apps/desktop-responder/src/responder.ts');
  const {createIdentity} = local('apps/desktop-responder/src/identity.ts');
  const {FakeEngine} = local('apps/desktop-responder/src/fake-engine.ts');
  const {RelayClient} = local('apps/mobile/lib/relay/client.ts');
  const {PairingManager} = local('apps/mobile/lib/session/session.ts');
  const {generateX25519Keypair,generateEd25519Keypair,ed25519Sign} = local('apps/mobile/lib/crypto/keys.ts');
  const {bytesToBase64} = local('apps/mobile/lib/crypto/base64.ts');
  const WebSocket = require(root + '/node_modules/ws');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'bimax-pairing-audit-'));
  const relay = spawn(process.execPath,[root+'/apps/relay/dist/index.js'],{cwd:root,env:{...process.env,PORT:'18891',DB_PATH:path.join(tmp,'relay.db')},stdio:'ignore'});
  let responder,phone;
  const sleep = ms=>new Promise(r=>setTimeout(r,ms));
  async function until(check) {const start=Date.now(); while(Date.now()-start<5000){if(await check())return; await sleep(30);}throw Error('audit loopback timeout');}
  try {
    await until(async()=>{try{return(await fetch('http://127.0.0.1:18891/health')).ok;}catch{return false;}});
    responder = new Responder({identity:createIdentity(),enginePort:new FakeEngine(),relayUrl:'ws://127.0.0.1:18891',dataDir:path.join(tmp,'desktop')});
    await responder.start();
    await until(()=>responder.relayClient.status==='online');
    let grant;
    const ed = generateEd25519Keypair();
    phone = new RelayClient({url:responder.pairingManager.getAdvertisement().relayUrl,deviceId:'audit-phone',role:'mobile',wsImpl:WebSocket,helloSigner:{pubkeyB64:bytesToBase64(ed.publicKey),sign:async msg=>ed25519Sign(ed.privateKey,msg)},onMessage:env=>{if(env.kind==='pairing_grant')grant=env;}});
    phone.connect(); await until(()=>phone.status==='online');
    const manager = new PairingManager({deviceId:'audit-phone',staticKeypair:generateX25519Keypair()});
    phone.send(manager.beginPairing(responder.pairingManager.getAdvertisement()));
    await until(()=>!!grant); manager.handleGrant(grant);
    const candidate = responder.pairingManager.getCandidatePairing();
    try {await responder.confirmTrustedPhone(candidate.verificationCode); console.log('REAL_RELAY_PAIRING_WITHOUT_OUT_OF_BAND_SIGNING_KEY','confirmed');}
    catch(e){console.log('REAL_RELAY_PAIRING_WITHOUT_OUT_OF_BAND_SIGNING_KEY',e.message);}
  } finally {
    phone?.close(); if(responder)await responder.stop(); relay.kill('SIGKILL');
    await new Promise(r=>relay.once('exit',r)); fs.rmSync(tmp,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
