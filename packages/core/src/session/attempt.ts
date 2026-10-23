/** A lease spans async key lookup, handshake and grant processing. Cancelling cannot
 * let an old completion clear or replace the currently active attempt. */
export class PairingAttemptScope {
  private current: symbol | null = null;
  get busy(): boolean {
    return this.current !== null;
  }
  begin(): { isCurrent(): boolean; finish(): void } {
    const token = Symbol("pairing-attempt");
    this.current = token;
    return {
      isCurrent: () => this.current === token,
      finish: () => {
        if (this.current === token) this.current = null;
      },
    };
  }
  capture(): () => boolean {
    const token = this.current;
    return () => this.current === token;
  }
  cancel(): void {
    this.current = null;
  }
}

export interface DesktopTrustIdentity {
  deviceId: string;
  staticPublicKeyB64: string;
  cryptoVersion?: 2;
}
export function sameDesktopTrust(
  a: DesktopTrustIdentity | null,
  b: DesktopTrustIdentity | null,
): boolean {
  return (
    a !== null &&
    b !== null &&
    a.deviceId === b.deviceId &&
    a.staticPublicKeyB64 === b.staticPublicKeyB64 &&
    a.cryptoVersion === b.cryptoVersion
  );
}

export function matchesDesktopSession(
  trust: DesktopTrustIdentity,
  session: { peerDeviceId: string; peerStaticPublicKey?: string },
): boolean {
  return (
    trust.deviceId === session.peerDeviceId &&
    trust.staticPublicKeyB64 === session.peerStaticPublicKey
  );
}
