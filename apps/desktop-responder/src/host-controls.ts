export interface RemoteOperation {
  kind: "command" | "chat" | "file" | "history";
  peer: string;
  text: string;
}

/** Main-owned trusted-pair policy and a visible connection indicator with local emergency Stop.
 * Pairing grants ordinary remote work; reconnecting the same pinned phone must not need a Mac prompt.
 * Authorization stays a host decision, never model text. Tool decisions retain their signed phone gate.
 */
export interface HostControls {
  setRemoteSessionActive(active: boolean, peer?: string): Promise<void>;
  authorize(operation: RemoteOperation, signal: AbortSignal): Promise<boolean>;
}
