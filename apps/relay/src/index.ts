/// <reference types="node" />
import http from "http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { Relay } from "./relay";
import { RelayStore } from "./store";

const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.RELAY_HOST || "127.0.0.1";
const admissionToken = process.env.RELAY_ADMISSION_TOKEN;
if (
  (admissionToken && admissionToken.length < 32) ||
  (!["127.0.0.1", "::1", "localhost"].includes(HOST) && !admissionToken)
)
  throw new Error("A LAN listener requires RELAY_ADMISSION_TOKEN with at least 32 characters");

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
  const presented = new URL(req.url || "/", "http://localhost").searchParams.get("lanToken") || "";
  const admitted =
    !admissionToken ||
    (Buffer.byteLength(presented) === Buffer.byteLength(admissionToken) &&
      timingSafeEqual(Buffer.from(presented), Buffer.from(admissionToken)));
  if (req.headers.origin || !admitted || wss.clients.size >= 32) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

const reapTimer = setInterval(() => relay.reapIdle(), 60_000);
(reapTimer as unknown as NodeJS.Timeout).unref();

server.listen(PORT, HOST, () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Relay address unavailable");
  console.log(`Bimax relay listening on port ${address.port}`);
  // Report the socket we actually own to parent-process integration runners. Port zero lets
  // independent suites avoid fixed-port collisions without a check-then-bind race.
  process.send?.({ type: "relay-listening", port: address.port });
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
