import type {
  PairingAdvertisement,
  PairingRequest,
  PairingGrant,
  Envelope,
} from "@bimax/protocol";

/**
 * Parses and validates a QR code pairing advertisement string.
 * Validates all five required fields: relayUrl, ref, desktopDeviceId, desktopPublicKey, app.
 * Throws an Error naming the offending field if invalid.
 */
export function parseAdvertisement(qrText: string): PairingAdvertisement {
  if (typeof qrText !== "string") {
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
  if (
    typeof obj.desktopDeviceId !== "string" ||
    obj.desktopDeviceId.trim().length === 0
  ) {
    throw new Error("parseAdvertisement: missing or invalid field 'desktopDeviceId'");
  }
  if (
    typeof obj.desktopPublicKey !== "string" ||
    obj.desktopPublicKey.trim().length === 0
  ) {
    throw new Error("parseAdvertisement: missing or invalid field 'desktopPublicKey'");
  }
  if (obj.app !== "bimax") {
    throw new Error("parseAdvertisement: missing or invalid field 'app' (must be 'bimax')");
  }

  return {
    relayUrl: obj.relayUrl,
    lanRelayUrl:
      typeof obj.lanRelayUrl === "string" && obj.lanRelayUrl.trim().length > 0
        ? obj.lanRelayUrl
        : undefined,
    ref: obj.ref,
    desktopDeviceId: obj.desktopDeviceId,
    desktopPublicKey: obj.desktopPublicKey,
    app: "bimax",
  };
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
  if (
    typeof mobilePublicKeyBase64 !== "string" ||
    mobilePublicKeyBase64.trim().length === 0
  ) {
    throw new Error("buildPairingRequest: invalid mobilePublicKeyBase64");
  }

  const randomId =
    "m-" +
    Math.random().toString(36).slice(2) +
    "-" +
    Date.now().toString(36);

  return {
    v: 1,
    id: randomId,
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
    throw new Error(
      `validateGrant: expected kind 'pairing_grant', received '${String(obj.kind)}'`,
    );
  }

  if (!obj.payload || typeof obj.payload !== "object" || Array.isArray(obj.payload)) {
    throw new Error("validateGrant: missing or invalid payload");
  }

  const payload = obj.payload as Record<string, unknown>;

  if (
    typeof payload.mobileDeviceId !== "string" ||
    payload.mobileDeviceId.trim().length === 0
  ) {
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

  return {
    mobileDeviceId: payload.mobileDeviceId,
    grantedAt: payload.grantedAt,
    handshakeMessage: payload.handshakeMessage,
  };
}
