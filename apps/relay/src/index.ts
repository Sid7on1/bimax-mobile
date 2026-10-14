/// <reference types="node" />
import http from "http";
import { WebSocketServer } from "ws";
import { Relay } from "./relay";
import { RelayStore } from "./store";

const PORT = parseInt(process.env.PORT || "8787", 10);

const store = new RelayStore();
const relay = new Relay(store);

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

wss.on("connection", (ws) => {
  relay.handleConnection(ws);
});

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

const reapTimer = setInterval(() => relay.reapIdle(), 60_000);
(reapTimer as unknown as NodeJS.Timeout).unref();

server.listen(PORT, () => {
  console.log(`Bimax relay listening on port ${PORT}`);
});

process.on("SIGINT", () => {
  clearInterval(reapTimer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  clearInterval(reapTimer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
});
