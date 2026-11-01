import type { ClientStatus } from "../relay/client";

/** A socket/handshake wait is not evidence that a Mac approval exists. */
export function pairingProgress(status: ClientStatus | "idle") {
  if (status === "online")
    return {
      title: "Establishing a secure connection…",
      description:
        "Keep Settings → Phone connection open on your Mac. A verification code will appear on both devices when the secure connection is ready.",
    };
  return {
    title: status === "reconnecting" ? "Reconnecting to your Mac…" : "Connecting to your Mac…",
    description:
      "Keep both devices on the same private Wi-Fi and your Mac awake. Allow Local Network access for Expo Go if your iPhone asks.",
  };
}
export function pairingTimeout(status: ClientStatus | "idle"): string {
  return status === "online"
    ? "Your Mac did not complete the secure connection. Scan a fresh QR code and keep Mac Settings → Phone connection open."
    : "Could not reach your Mac. Check the same Wi-Fi network and Expo Go Local Network permission, then scan a fresh QR code.";
}
