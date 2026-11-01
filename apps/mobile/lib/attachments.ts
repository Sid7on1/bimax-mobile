// lib/attachments.ts
import { File, FileMode } from "expo-file-system";
import { randomId } from "./crypto/keys";
import { bytesToBase64 } from "./crypto/base64";
import * as DocumentPicker from "expo-document-picker";
import type * as ImagePickerTypes from "expo-image-picker";

export interface AttachedFile {
  id: string;
  name: string;
  size: number;
  mimeType?: string;
  uri: string;
  inlinedContent?: string;
  base64Data?: string;
  isImage?: boolean;
}

const MAX_INLINE_SIZE = 200 * 1024; // 200 KB
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const TEXT_EXTENSIONS = [
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".ts",
  ".js",
  ".py",
  ".sql",
  ".html",
  ".css",
];

function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function detectImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 137 &&
    bytes[1] === 80 &&
    bytes[2] === 78 &&
    bytes[3] === 71 &&
    bytes[4] === 13 &&
    bytes[5] === 10 &&
    bytes[6] === 26 &&
    bytes[7] === 10
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const header6 = new TextDecoder().decode(bytes.subarray(0, 6));
    if (header6 === "GIF87a" || header6 === "GIF89a") {
      return "image/gif";
    }
  }
  if (bytes.length >= 12) {
    const header12 = new TextDecoder().decode(bytes.subarray(0, 12));
    if (header12.startsWith("RIFF") && header12.slice(8, 12) === "WEBP") {
      return "image/webp";
    }
  }
  return null;
}

/**
 * Inlines text files <200KB; rejects non-text or oversize files on the text document path.
 */
export async function ingestFile(file: AttachedFile): Promise<AttachedFile> {
  if (!isTextFile(file.name) || file.size >= MAX_INLINE_SIZE)
    throw new Error(
      "Attach a text or source file smaller than 200 KB. Images and PDFs are not supported yet.",
    );
  if (!file.uri.startsWith("file://")) throw new Error("Only local document copies are supported");
  const handle = new File(file.uri).open(FileMode.ReadOnly);
  let bytes: Uint8Array | undefined;
  try {
    // Never trust picker metadata or read the entire file. One extra byte detects overflow.
    bytes = await handle.readBytes(MAX_INLINE_SIZE + 1);
    if (bytes.length >= MAX_INLINE_SIZE) throw new Error("Text file exceeds 200 KB");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ...file, size: bytes.length, uri: "", inlinedContent: text };
  } finally {
    bytes?.fill(0);
    handle.close();
  }
}

export async function ingestImageFile(file: AttachedFile): Promise<AttachedFile> {
  if (!file.uri.startsWith("file://")) throw new Error("Only local image copies are supported");
  const handle = new File(file.uri).open(FileMode.ReadOnly);
  let bytes: Uint8Array | undefined;
  try {
    bytes = await handle.readBytes(MAX_IMAGE_SIZE + 1);
    if (bytes.length === 0) throw new Error("Selected image is empty");
    if (bytes.length > MAX_IMAGE_SIZE) throw new Error("Image file exceeds 10 MB limit");
    const detectedMime = detectImageMime(bytes);
    if (!detectedMime) {
      throw new Error("Unsupported image format (PNG, JPEG, GIF, or WebP required)");
    }
    const base64Data = bytesToBase64(bytes);
    return {
      ...file,
      size: bytes.length,
      mimeType: detectedMime,
      uri: "",
      base64Data,
      isImage: true,
    };
  } finally {
    bytes?.fill(0);
    handle.close();
  }
}

export async function pickDocument(): Promise<AttachedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
  });

  if (result.canceled || !result.assets || result.assets.length === 0) {
    return null;
  }

  const asset = result.assets[0];
  if (!asset) return null;

  const rawFile: AttachedFile = {
    id: randomId("doc"),
    name: asset.name,
    size: asset.size ?? 0,
    mimeType: asset.mimeType ?? undefined,
    uri: asset.uri,
  };

  try {
    return await ingestFile(rawFile);
  } finally {
    if (asset.uri.startsWith("file://")) new File(asset.uri).delete();
  }
}

export async function pickImage(): Promise<AttachedFile | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ImagePicker = require("expo-image-picker") as typeof ImagePickerTypes;
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error("Photo library permission is required to attach images");
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.9,
  });

  if (result.canceled || !result.assets || result.assets.length === 0) {
    return null;
  }

  const asset = result.assets[0];
  if (!asset) return null;

  const fallbackExt =
    asset.mimeType === "image/png"
      ? ".png"
      : asset.mimeType === "image/gif"
        ? ".gif"
        : asset.mimeType === "image/webp"
          ? ".webp"
          : ".jpg";
  const rawFile: AttachedFile = {
    id: randomId("img"),
    name: asset.fileName || `image-${Date.now()}${fallbackExt}`,
    size: asset.fileSize ?? 0,
    mimeType: asset.mimeType ?? "image/jpeg",
    uri: asset.uri,
    isImage: true,
  };

  try {
    return await ingestImageFile(rawFile);
  } finally {
    if (asset.uri.startsWith("file://")) {
      try {
        new File(asset.uri).delete();
      } catch {
        // ignore cleanup errors on system photo URIs
      }
    }
  }
}

/** Files remain JSON string data; role-like text cannot alter the message structure.
 * Models can still be influenced by file content. Desktop effects require independent host consent.
 */
export function buildAttachmentPrompt(input: string, files: AttachedFile[]): string {
  if (!files.length) return input;
  return JSON.stringify({
    userRequest: input,
    untrustedAttachments: files.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      isImage: Boolean(file.isImage),
      content:
        file.inlinedContent ??
        (file.isImage ? `[Image attachment: ${file.name} (${file.size} bytes)]` : ""),
    })),
  });
}
