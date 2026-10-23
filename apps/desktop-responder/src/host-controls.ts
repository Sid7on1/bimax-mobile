export interface RemoteOperation {
  kind: "command" | "chat" | "file";
  peer: string;
  text: string;
}

/** Implement in the desktop host using a visible session banner and a local confirmation UI.
 * The banner must expose Responder.emergencyStop(), including when the network is unavailable.
 * Authorization is a host decision, never a model-generated decision or a shell blocklist.
 */
export interface HostControls {
  setRemoteSessionActive(active: boolean, peer?: string): Promise<void>;
  authorize(operation: RemoteOperation, signal: AbortSignal): Promise<boolean>;
}
