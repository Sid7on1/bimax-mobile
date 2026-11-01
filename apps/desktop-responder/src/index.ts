import type { EnginePort } from "./engine-port";
import { loadOrCreateIdentity, loadIdentity, type IdentityStore } from "./identity";
import { Responder } from "./responder";
import type { HostControls } from "./host-controls";
export * from "./host-controls";

export * from "./engine-port";
export * from "./identity";
export * from "./pairing";
export * from "./relay-client";
export * from "./e2e";
export * from "./approvals";
export * from "./idempotency";
export * from "./files";
export * from "./chat";
export * from "./relay-admission";
export * from "./responder";

/**
 * Creates and initializes a desktop Responder instance with an injected EnginePort.
 * No engine implementation is imported here — the port must be supplied by the caller.
 */
export async function startResponder(opts: {
  enginePort: EnginePort;
  relayUrl: string;
  identityPath?: string;
  identityStore?: IdentityStore;
  allowInsecureFileIdentity?: boolean;
  authorizeRelayUrl?: (url: string) => Promise<string>;
  lanRelayUrl?: string;
  dataDir?: string;
  hostControls: HostControls;
  enablePqPairing?: boolean;
}): Promise<Responder> {
  if (!opts.identityStore && !(opts.allowInsecureFileIdentity && opts.identityPath))
    throw new Error(
      "Supply an OS-backed identityStore. Plaintext file identity requires explicit development opt-in.",
    );
  const identity = opts.identityStore
    ? await loadIdentity(opts.identityStore)
    : await loadOrCreateIdentity(opts.identityPath!);
  const responder = new Responder({
    identity,
    enginePort: opts.enginePort,
    relayUrl: opts.relayUrl,
    lanRelayUrl: opts.lanRelayUrl,
    dataDir: opts.dataDir,
    authorizeRelayUrl: opts.authorizeRelayUrl,
    hostControls: opts.hostControls,
    enablePqPairing: opts.enablePqPairing,
  });

  await responder.start();
  return responder;
}

export * from "./lan-relay";

export * from "./history";

export * from "./live";
