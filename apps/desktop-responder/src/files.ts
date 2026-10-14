import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  FileOffer,
  FileAccept,
  FileReject,
  FileChunk,
  FileDone,
  FileReceived,
  FileError,
} from "@bimax/protocol";
import type { EnginePort } from "./engine-port";
import { sha256Bytes } from "./crypto/keys";
import { base64ToBytes } from "./crypto/base64";
import { generateDeviceId } from "./identity";

export interface ActiveTransfer {
  offer: FileOffer;
  createdAt: number;
  expectedSeq: number;
  chunks: Uint8Array[];
  receivedBytes: number;
}

export interface FilePipelineOptions {
  inboxDir: string;
  enginePort: EnginePort;
  offerTtlMs?: number;
}

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_CHUNK_SIZE_BYTES = 64 * 1024; // 64 KB
const DEFAULT_OFFER_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CONCURRENT_TRANSFERS = 4;

const TRANSFER_ID_REGEX = /^[0-9a-fA-F]{32}$/;

export class FilePipeline {
  private inboxDir: string;
  private enginePort: EnginePort;
  private offerTtlMs: number;
  private activeTransfers = new Map<string, ActiveTransfer>();

  constructor(opts: FilePipelineOptions) {
    this.inboxDir = opts.inboxDir;
    this.enginePort = opts.enginePort;
    this.offerTtlMs = opts.offerTtlMs ?? DEFAULT_OFFER_TTL_MS;
  }

  public async init(): Promise<void> {
    await fs.mkdir(this.inboxDir, { recursive: true });
  }

  /**
   * Validates MIME against allowlist:
   * application/pdf, image/*, text/*, application/octet-stream
   */
  public static isAllowedMime(mime: string): boolean {
    if (typeof mime !== "string") return false;
    const lower = mime.toLowerCase().trim();
    if (lower === "application/pdf" || lower === "application/octet-stream") {
      return true;
    }
    if (lower.startsWith("image/") || lower.startsWith("text/")) {
      return true;
    }
    return false;
  }

  /**
   * Handles incoming file_offer.
   * Validates caps, mime, transferId shape -> accept or reject.
   */
  public handleOffer(
    offer: FileOffer,
    now: number = Date.now(),
  ): { accept: FileAccept } | { reject: FileReject } {
    this.sweepExpired(now);

    if (!offer || typeof offer !== "object") {
      return { reject: { transferId: "", reason: "Malformed offer" } };
    }

    const { transferId, name, mime, sizeBytes, sha256 } = offer;

    // 1. transferId: 128-bit random hex (32 hex characters)
    if (typeof transferId !== "string" || !TRANSFER_ID_REGEX.test(transferId)) {
      return {
        reject: {
          transferId: typeof transferId === "string" ? transferId : "",
          reason: "Invalid transferId: must be 128-bit hex string",
        },
      };
    }

    if (this.activeTransfers.has(transferId)) {
      return {
        reject: {
          transferId,
          reason: "Duplicate transferId already in progress",
        },
      };
    }

    if (this.activeTransfers.size >= MAX_CONCURRENT_TRANSFERS) {
      return { reject: { transferId, reason: "Too many concurrent transfers" } };
    }

    // 2. Caps
    if (typeof name !== "string" || name.length === 0 || name.length > 255) {
      return {
        reject: {
          transferId,
          reason: "Invalid file name: length must be between 1 and 255 characters",
        },
      };
    }

    if (
      typeof sizeBytes !== "number" ||
      !Number.isFinite(sizeBytes) ||
      !Number.isInteger(sizeBytes) ||
      sizeBytes <= 0 ||
      sizeBytes > MAX_FILE_SIZE_BYTES
    ) {
      return {
        reject: {
          transferId,
          reason: `Invalid size: must be an integer <= 25 MB (got ${sizeBytes})`,
        },
      };
    }

    if (!FilePipeline.isAllowedMime(mime)) {
      return {
        reject: {
          transferId,
          reason: `Disallowed MIME type: ${mime}`,
        },
      };
    }

    if (typeof sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(sha256)) {
      return {
        reject: {
          transferId,
          reason: "Invalid sha256 hash format",
        },
      };
    }

    // Accept transfer
    this.activeTransfers.set(transferId, {
      offer,
      createdAt: now,
      expectedSeq: 0,
      chunks: [],
      receivedBytes: 0,
    });

    return { accept: { transferId } };
  }

  /**
   * Handles incoming file_chunk.
   * Enforces strict sequence and max 64 KB chunk size.
   */
  public handleChunk(
    chunk: FileChunk,
    now: number = Date.now(),
  ): { error?: FileError } {
    this.sweepExpired(now);

    if (!chunk || typeof chunk !== "object") {
      return {
        error: {
          transferId: "",
          code: "MALFORMED_CHUNK",
          message: "Chunk is not an object",
        },
      };
    }

    const { transferId, seq, data } = chunk;
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) {
      return {
        error: {
          transferId,
          code: "UNKNOWN_TRANSFER",
          message: "No active transfer found or transfer expired",
        },
      };
    }

    // Strict sequence check
    if (seq !== transfer.expectedSeq) {
      this.activeTransfers.delete(transferId);
      return {
        error: {
          transferId,
          code: "SEQUENCE_ERROR",
          message: `Expected chunk sequence ${transfer.expectedSeq}, received ${seq}`,
        },
      };
    }

    // Decode base64 data
    let decoded: Uint8Array;
    try {
      decoded = base64ToBytes(data);
    } catch {
      this.activeTransfers.delete(transferId);
      return {
        error: {
          transferId,
          code: "DECODE_ERROR",
          message: "Failed to decode base64 chunk data",
        },
      };
    }

    // Max 64 KB per chunk
    if (decoded.length > MAX_CHUNK_SIZE_BYTES) {
      this.activeTransfers.delete(transferId);
      return {
        error: {
          transferId,
          code: "CHUNK_TOO_LARGE",
          message: `Chunk size ${decoded.length} exceeds 64 KB limit`,
        },
      };
    }

    // Overflow check
    if (transfer.receivedBytes + decoded.length > transfer.offer.sizeBytes) {
      this.activeTransfers.delete(transferId);
      return {
        error: {
          transferId,
          code: "SIZE_EXCEEDED",
          message: `Received bytes exceeded declared size ${transfer.offer.sizeBytes}`,
        },
      };
    }

    transfer.chunks.push(decoded);
    transfer.receivedBytes += decoded.length;
    transfer.expectedSeq += 1;

    return {};
  }

  /**
   * Handles incoming file_done.
   * Verifies exact byte count and SHA-256 against offer.sha256.
   * Stores to <inboxDir>/<fileId> with sidecar metadata.
   * Calls enginePort.attachFile.
   */
  public async handleDone(
    done: FileDone,
    now: number = Date.now(),
  ): Promise<{ received?: FileReceived; error?: FileError }> {
    this.sweepExpired(now);

    if (!done || typeof done !== "object") {
      return {
        error: {
          transferId: "",
          code: "MALFORMED_DONE",
          message: "Done frame is not an object",
        },
      };
    }

    const { transferId } = done;
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) {
      return {
        error: {
          transferId,
          code: "UNKNOWN_TRANSFER",
          message: "No active transfer found or transfer expired",
        },
      };
    }

    this.activeTransfers.delete(transferId);

    // Exact byte count verification
    const total = transfer.receivedBytes;
    if (total !== transfer.offer.sizeBytes) {
      return {
        error: {
          transferId,
          code: "SIZE_MISMATCH",
          message: `Expected ${transfer.offer.sizeBytes} bytes, received ${total}`,
        },
      };
    }

    // Reassemble bytes
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of transfer.chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    // Verify SHA-256
    const hashBytes = sha256Bytes(combined);
    let actualHex = "";
    for (let i = 0; i < hashBytes.length; i++) {
      const b = hashBytes[i];
      if (b !== undefined) {
        actualHex += b.toString(16).padStart(2, "0");
      }
    }

    const expectedHex = transfer.offer.sha256.toLowerCase();
    if (actualHex !== expectedHex) {
      return {
        error: {
          transferId,
          code: "INTEGRITY_ERROR",
          message: `SHA-256 mismatch: expected ${expectedHex}, got ${actualHex}`,
        },
      };
    }

    // Responder-generated fileId (original name kept OUT of the path)
    const fileId = "f-" + generateDeviceId();
    const filePath = path.join(this.inboxDir, fileId);
    const metaPath = path.join(this.inboxDir, `${fileId}.meta.json`);

    try {
      await fs.mkdir(this.inboxDir, { recursive: true });
      await fs.writeFile(filePath, combined);

      const metadata = {
        fileId,
        name: transfer.offer.name,
        mime: transfer.offer.mime,
        sizeBytes: total,
        sha256: expectedHex,
        receivedAt: now,
      };
      await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), "utf-8");

      // Inform engine
      await this.enginePort.attachFile({
        fileId,
        name: transfer.offer.name,
        mime: transfer.offer.mime,
        sizeBytes: total,
      });
    } catch {
      await fs.unlink(filePath).catch(() => {});
      await fs.unlink(metaPath).catch(() => {});
      return {
        error: {
          transferId,
          code: "STORAGE_ERROR",
          message: "Failed to persist or attach received file",
        },
      };
    }

    return {
      received: {
        transferId,
        fileId,
      },
    };
  }

  private sweepExpired(now: number): void {
    for (const [id, t] of this.activeTransfers.entries()) {
      if (now - t.createdAt > this.offerTtlMs) {
        this.activeTransfers.delete(id);
      }
    }
  }
}
