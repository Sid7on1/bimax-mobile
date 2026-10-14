// lib/attachments.ts
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";

export interface AttachedFile {
  id: string;
  name: string;
  size: number;
  mimeType?: string;
  uri: string;
  inlinedContent?: string;
  isImage?: boolean;
}

const MAX_INLINE_SIZE = 200 * 1024; // 200 KB
const TEXT_EXTENSIONS = [".txt", ".md", ".json", ".csv", ".ts", ".js", ".py", ".sql", ".html", ".css"];

function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Seam for PROMPT-19 (OCR / PDF / Vision pipeline).
 * For v1, inlines text files <200KB; otherwise marks as labeled reference.
 */
export async function ingestFile(file: AttachedFile): Promise<AttachedFile> {
  if (isTextFile(file.name) && file.size < MAX_INLINE_SIZE) {
    try {
      const response = await fetch(file.uri);
      const text = await response.text();
      return {
        ...file,
        inlinedContent: text,
      };
    } catch (_err) {
      return file;
    }
  }

  // Vision/PDF pipeline lands in PROMPT-19
  return file;
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
    id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: asset.name,
    size: asset.size ?? 0,
    mimeType: asset.mimeType ?? undefined,
    uri: asset.uri,
  };

  return ingestFile(rawFile);
}

export async function pickImage(): Promise<AttachedFile | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.8,
  });

  if (result.canceled || !result.assets || result.assets.length === 0) {
    return null;
  }

  const asset = result.assets[0];
  if (!asset) return null;

  const name = asset.fileName || `image-${Date.now()}.jpg`;
  const rawFile: AttachedFile = {
    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    size: asset.fileSize ?? 0,
    mimeType: asset.mimeType ?? "image/jpeg",
    uri: asset.uri,
    isImage: true,
  };

  return ingestFile(rawFile);
}
