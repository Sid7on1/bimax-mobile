import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { Relay, type RelayStorage } from '@bimax/core/relay/node';

/** LAN relay is memory-only: durable trust belongs to the responder, not the router. */
export async function createLanRelay(options: { host: string; port: number; token: string; desktopDeviceId: string }) {
  if (options.token.length < 32) throw new Error('LAN admission requires a random token');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE pins(device_id TEXT PRIMARY KEY,pubkey TEXT NOT NULL); CREATE TABLE devices(device_id TEXT PRIMARY KEY,role TEXT NOT NULL,last_seen INTEGER NOT NULL);');
  const rows = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as unknown as Array<{device_id:string;role:string;last_seen:number}>;
  const store: RelayStorage = {
    getSql: () => ({ exec: (sql, ...params) => {
      const stmt = db.prepare(sql), values = params as SQLInputValue[];
      if (stmt.columns().length) return { rows: stmt.all(...values) };
      stmt.run(...values); return { rows: [] };
    } }),
    recordDevice: (id, role, at) => { db.prepare('INSERT INTO devices VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET role=excluded.role,last_seen=excluded.last_seen').run(id,role,at); },
    updateLastSeen: (id, at) => { db.prepare('UPDATE devices SET last_seen=? WHERE device_id=?').run(at,id); },
    getOtherDevices: id => rows('SELECT * FROM devices WHERE device_id<>?',id),
    getAllDevices: () => rows('SELECT * FROM devices'),
  };
  const relay = new Relay(store), server = http.createServer((_req,res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer:true, maxPayload:256*1024 });
  server.on('upgrade', (request,socket,head) => {
    let admitted = false;
    try {
      const url = new URL(request.url || '/', 'http://localhost'), token = url.searchParams.get('lanToken') || '';
      admitted = !request.headers.origin && url.pathname === `/room/${options.desktopDeviceId}` && Buffer.byteLength(token) === Buffer.byteLength(options.token) && timingSafeEqual(Buffer.from(token),Buffer.from(options.token));
    } catch { /* malformed upgrades refuse */ }
    if (!admitted || sockets.clients.size >= 8) { socket.destroy(); return; }
    sockets.handleUpgrade(request,socket,head,ws => relay.handleConnection(ws));
  });
  server.headersTimeout=5000; server.requestTimeout=5000; server.maxConnections=16;
  try { await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(options.port,options.host,()=>{server.removeListener('error',reject);resolve();}); }); }
  catch(error) { sockets.close(); db.close(); throw error; }
  const timer = setInterval(() => relay.reapIdle(),30000); (timer as unknown as NodeJS.Timeout).unref();
  let closed = false;
  return {
    port: (server.address() as {port:number}).port,
    isDeviceOnline: (id:string) => relay.isDeviceOnline(id),
    close: async () => { if(closed)return;closed=true;clearInterval(timer);for(const client of sockets.clients)client.terminate();await new Promise<void>(resolve=>sockets.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));db.close(); },
  };
}
