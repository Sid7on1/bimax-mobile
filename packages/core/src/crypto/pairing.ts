import { validateRelayUrl } from "../relay/url";
import { base64ToBytes } from "./base64";
import { randomId } from "./keys";
import { assertPqAdvertisement, isPqAdvertisement } from "./pq";
import type { PairingAdvertisement, PairingRequest, PairingGrant, Envelope } from "@bimax/protocol";

/**
 * Parses and validates a QR code pairing advertisement string.
 * Validates all five required fields: relayUrl, ref, desktopDeviceId, desktopPublicKey, app.
 * Throws an Error naming the offending field if invalid.
 */
export function parseAdvertisement(qrText: string): PairingAdvertisement {
  if (typeof qrText !== "string" || qrText.length > 8192) {
    throw new Error("parseAdvertisement: expected string input");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(qrText);
  } catch (err) {
    throw new Error(
      `parseAdvertisement: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("parseAdvertisement: expected JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.relayUrl !== "string" || obj.relayUrl.trim().length === 0) {
    throw new Error("parseAdvertisement: missing or invalid field 'relayUrl'");
  }
  if (typeof obj.ref !== "string" || obj.ref.trim().length === 0) {
    throw new Error("parseAdvertisement: missing or invalid field 'ref'");
  }
  if (typeof obj.desktopDeviceId !== "string" || obj.desktopDeviceId.trim().length === 0) {
    throw new Error("parseAdvertisement: missing or invalid field 'desktopDeviceId'");
  }
  if (typeof obj.desktopPublicKey !== "string" || obj.desktopPublicKey.trim().length === 0) {
    throw new Error("parseAdvertisement: missing or invalid field 'desktopPublicKey'");
  }
  if (obj.app !== "bimax") {
    throw new Error("parseAdvertisement: missing or invalid field 'app' (must be 'bimax')");
  }

  validateRelayUrl(obj.relayUrl);
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(obj.desktopDeviceId) ||
    obj.ref.length > 128 ||
    base64ToBytes(obj.desktopPublicKey).length !== 32
  )
    throw new Error("Invalid pairing identity");
  const res: PairingAdvertisement = {
    relayUrl: obj.relayUrl,
    ref: obj.ref,
    desktopDeviceId: obj.desktopDeviceId,
    desktopPublicKey: obj.desktopPublicKey,
    app: "bimax",
  };
  if (typeof obj.lanRelayUrl === "string" && obj.lanRelayUrl.trim().length > 0) {
    validateRelayUrl(obj.lanRelayUrl);
    res.lanRelayUrl = obj.lanRelayUrl; // Preserve the scanned bytes used by the PQ transcript.
  }
  if (isPqAdvertisement(obj as unknown as PairingAdvertisement)) {
    Object.assign(res, {
      cryptoVersion: obj.cryptoVersion,
      suite: obj.suite,
      pqPrekeyId: obj.pqPrekeyId,
      pqPrekeyHash: obj.pqPrekeyHash,
      expiresAt: obj.expiresAt,
    });
    assertPqAdvertisement(res);
  }
  return res;
}

/**
 * Builds a pairing request envelope to send to the desktop device.
 */
export function buildPairingRequest(
  advert: PairingAdvertisement,
  mobileDeviceId: string,
  mobilePublicKeyBase64: string,
  handshakeMessageBase64: string = "",
): Envelope<"pairing_request", PairingRequest> {
  if (typeof mobileDeviceId !== "string" || mobileDeviceId.trim().length === 0) {
    throw new Error("buildPairingRequest: invalid mobileDeviceId");
  }
  if (typeof mobilePublicKeyBase64 !== "string" || mobilePublicKeyBase64.trim().length === 0) {
    throw new Error("buildPairingRequest: invalid mobilePublicKeyBase64");
  }

  if (isPqAdvertisement(advert))
    throw new Error("Use PairingManager for PQ advertisements; classical fallback forbidden");
  const envelopeId = randomId();

  return {
    v: 2,
    id: envelopeId,
    ts: Date.now(),
    from: mobileDeviceId,
    to: advert.desktopDeviceId,
    kind: "pairing_request",
    payload: {
      ref: advert.ref,
      mobileDeviceId,
      mobilePublicKey: mobilePublicKeyBase64,
      handshakeMessage: handshakeMessageBase64,
    },
  };
}

/**
 * Validates that an incoming envelope is a valid pairing_grant and extracts the grant payload.
 * Throws an Error if not an object, kind is not "pairing_grant", or payload fields are missing/wrong type.
 */
export function validateGrant(env: unknown): PairingGrant {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("validateGrant: expected envelope object");
  }

  const obj = env as Record<string, unknown>;

  if (obj.kind !== "pairing_grant") {
    throw new Error(`validateGrant: expected kind 'pairing_grant', received '${String(obj.kind)}'`);
  }

  if (!obj.payload || typeof obj.payload !== "object" || Array.isArray(obj.payload)) {
    throw new Error("validateGrant: missing or invalid payload");
  }

  const payload = obj.payload as Record<string, unknown>;

  if (typeof payload.mobileDeviceId !== "string" || payload.mobileDeviceId.trim().length === 0) {
    throw new Error("validateGrant: missing or invalid field 'mobileDeviceId' in payload");
  }

  if (typeof payload.grantedAt !== "number" || !Number.isFinite(payload.grantedAt)) {
    throw new Error("validateGrant: missing or invalid field 'grantedAt' in payload");
  }

  if (
    typeof payload.handshakeMessage !== "string" ||
    payload.handshakeMessage.trim().length === 0
  ) {
    throw new Error("validateGrant: missing or invalid field 'handshakeMessage' in payload");
  }

  if (
    payload.handshakeId !== undefined &&
    (typeof payload.handshakeId !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(payload.handshakeId))
  )
    throw new Error("validateGrant: invalid handshakeId");
  return {
    mobileDeviceId: payload.mobileDeviceId,
    grantedAt: payload.grantedAt,
    handshakeMessage: payload.handshakeMessage,
    ...(payload.handshakeId !== undefined ? { handshakeId: payload.handshakeId as string } : {}),
  };
}
