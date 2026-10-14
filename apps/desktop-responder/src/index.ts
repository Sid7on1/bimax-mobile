import type { EnginePort } from "./engine-port";
import { loadOrCreateIdentity } from "./identity";
import { Responder } from "./responder";

export * from "./engine-port";
export * from "./identity";
export * from "./pairing";
export * from "./relay-client";
export * from "./e2e";
export * from "./approvals";
export * from "./idempotency";
export * from "./files";
export * from "./chat";
export * from "./fake-engine";
export * from "./responder";

/**
 * Creates and initializes a desktop Responder instance with an injected EnginePort.
 * No engine implementation is imported here — the port must be supplied by the caller.
 */
export async function startResponder(opts: {
  enginePort: EnginePort;
  relayUrl: string;
  identityPath: string;
  lanRelayUrl?: string;
  dataDir?: string;
}): Promise<Responder> {
  const identity = await loadOrCreateIdentity(opts.identityPath);
  const responder = new Responder({
    identity,
    enginePort: opts.enginePort,
    relayUrl: opts.relayUrl,
    lanRelayUrl: opts.lanRelayUrl,
    dataDir: opts.dataDir,
  });

  await responder.start();
  return responder;
}
