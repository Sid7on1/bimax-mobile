import type { MessageKind } from "@bimax/protocol";
import type { EstablishedSession } from "./session/session";
import {
  seal as framingSeal,
  open as framingOpen,
  newE2EState,
  type E2EState,
  type OpenResult,
  type SealedFrame,
} from "./e2e/framing";

export { newE2EState, type E2EState, type OpenResult, type SealedFrame };

export class E2ERegistry {
  private peerStates = new Map<string, E2EState>();

  /**
   * Resets the E2E state for a peer.
   * Contract §5 MANDATORY RULE: both peers MUST reset E2E state (`newE2EState()`)
   * on every newly established Noise transport session.
   */
  public resetPeer(peerDeviceId: string): E2EState {
    const fresh = newE2EState();
    this.peerStates.set(peerDeviceId, fresh);
    return fresh;
  }

  /**
   * Clears state for a peer (e.g. upon teardown or revoke).
   */
  public clearPeer(peerDeviceId: string): void {
    this.peerStates.delete(peerDeviceId);
  }

  /**
   * Gets the E2E state for a peer, creating one if not present.
   */
  public getOrCreatePeerState(peerDeviceId: string): E2EState {
    let state = this.peerStates.get(peerDeviceId);
    if (!state) {
      state = newE2EState();
      this.peerStates.set(peerDeviceId, state);
    }
    return state;
  }

  /**
   * Seals a frame for transmission to the peer.
   */
  public seal(
    session: EstablishedSession,
    innerKind: MessageKind,
    body: unknown,
    outer: { id: string; from: string; to: string },
  ): string {
    const state = this.getOrCreatePeerState(session.peerDeviceId);
    return framingSeal(session, state, innerKind, body, outer);
  }

  /**
   * Opens an encrypted frame received from the peer.
   * Enforces 256 KB max inner message cap and replay protection.
   */
  public open(
    session: EstablishedSession,
    outer: {
      id: string;
      from: string;
      to: string;
      kind: string;
      ciphertextB64: string;
    },
  ): OpenResult {
    const state = this.getOrCreatePeerState(session.peerDeviceId);
    return framingOpen(session, state, outer);
  }
}
