import type { RelayClient } from "../relay/client";
import type { TrustedDesktop } from "../crypto";

export function getCandidateRelayUrls(trusted: TrustedDesktop): string[] {
  return trusted.lanRelayUrl && trusted.lastWorking !== "cloud"
    ? [trusted.lanRelayUrl, trusted.relayUrl]
    : [trusted.relayUrl, ...(trusted.lanRelayUrl ? [trusted.lanRelayUrl] : [])];
}

export async function probeTrustedRelay(options: {
  trusted: TrustedDesktop;
  connectToRelay: (url: string) => RelayClient;
  isOnline: () => boolean;
  isMounted: () => boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<{
  client: RelayClient;
  url: string;
  lastWorking: "lan" | "cloud";
} | null> {
  const {
    trusted,
    connectToRelay,
    isOnline,
    isMounted,
    timeoutMs = 4000,
    pollIntervalMs = 150,
  } = options;

  const candidateUrls = getCandidateRelayUrls(trusted);

  for (const url of candidateUrls) {
    if (!isMounted()) return null;
    const client = connectToRelay(url);

    const start = Date.now();
    let connected = false;
    while (Date.now() - start < timeoutMs) {
      if (!isMounted()) return null;
      if (isOnline()) {
        connected = true;
        break;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    if (!isMounted()) return null;
    if (connected) {
      const lastWorking: "lan" | "cloud" = url === trusted.lanRelayUrl ? "lan" : "cloud";
      return { client, url, lastWorking };
    }
  }

  return null;
}
