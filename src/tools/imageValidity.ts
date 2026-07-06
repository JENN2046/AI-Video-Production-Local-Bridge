import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export type SupportedImageMime = "image/png" | "image/jpeg";

export interface ImageValidationResult {
  ok: boolean;
  path: string;
  width: number;
  height: number;
  aspect_ratio: string;
  detected_mime: SupportedImageMime | "";
  extension: ".png" | ".jpg" | "";
  sha256: string;
  error_code: string;
  error: string;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

export function aspectRatioFor(width: number, height: number): string {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function invalid(path: string, errorCode: string, error: string): ImageValidationResult {
  return {
    ok: false,
    path,
    width: 0,
    height: 0,
    aspect_ratio: "",
    detected_mime: "",
    extension: "",
    sha256: "",
    error_code: errorCode,
    error
  };
}

function inspectPng(buffer: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function inspectJpeg(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    offset += 2;

    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) return null;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;

    const isStartOfFrame =
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf;
    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5)
      };
    }

    offset += segmentLength;
  }

  return null;
}

export function validateImageBuffer(buffer: Buffer, path = ""): ImageValidationResult {
  const png = inspectPng(buffer);
  const jpeg = png ? null : inspectJpeg(buffer);
  const dimensions = png ?? jpeg;
  if (!dimensions) {
    return invalid(path, "IMAGE_FILE_INVALID", "Image content is not a supported PNG or JPEG file.");
  }

  if (dimensions.width <= 0 || dimensions.height <= 0) {
    return invalid(path, "IMAGE_DIMENSIONS_UNREADABLE", "Image dimensions must be positive.");
  }

  const detectedMime: SupportedImageMime = png ? "image/png" : "image/jpeg";
  return {
    ok: true,
    path,
    width: dimensions.width,
    height: dimensions.height,
    aspect_ratio: aspectRatioFor(dimensions.width, dimensions.height),
    detected_mime: detectedMime,
    extension: detectedMime === "image/png" ? ".png" : ".jpg",
    sha256: createHash("sha256").update(buffer).digest("hex"),
    error_code: "",
    error: ""
  };
}

export function validateImageFile(filePath: string): ImageValidationResult {
  if (!existsSync(filePath)) {
    return invalid(filePath, "IMAGE_FILE_NOT_READABLE", "Image file does not exist.");
  }

  try {
    return validateImageBuffer(readFileSync(filePath), filePath);
  } catch (error) {
    return invalid(filePath, "IMAGE_FILE_NOT_READABLE", error instanceof Error ? error.message : "Image file is not readable.");
  }
}
