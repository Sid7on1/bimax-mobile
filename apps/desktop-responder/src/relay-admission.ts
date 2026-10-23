/** Inject the desktop's signed-in account credential; provider API keys are never used. */
export function createRelayAuthorizer(
  gatewayUrl: string,
  getAccessToken: () => Promise<string>,
  deviceId: string,
  helloPubkey: string,
) {
  if (!gatewayUrl.startsWith("https://")) throw new Error("Gateway requires HTTPS");
  return async (relayUrl: string): Promise<string> => {
    const url = new URL(relayUrl);
    if (url.protocol === "ws:") return relayUrl;
    if (url.protocol !== "wss:") throw new Error("Invalid relay transport");
    const roomId = url.pathname.split("/").pop();
    const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}/v1/relay-ticket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await getAccessToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roomId, deviceId, role: "desktop", helloPubkey }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Relay admission denied");
    const { ticket } = (await response.json()) as { ticket: string };
    url.searchParams.set("ticket", ticket);
    return url.toString();
  };
}
