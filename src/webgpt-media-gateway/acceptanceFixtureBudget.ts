import { READONLY_MEDIA_GATEWAY_MAX_FILE_BYTES } from "./limits.js";

export const READONLY_MEDIA_ACCEPTANCE_VARIANT_TRAILER = Buffer.from([
  0x00, 0x00, 0x00, 0x08, 0x66, 0x72, 0x65, 0x65
]);

export const READONLY_MEDIA_ACCEPTANCE_MAX_SOURCE_BYTES =
  READONLY_MEDIA_GATEWAY_MAX_FILE_BYTES - READONLY_MEDIA_ACCEPTANCE_VARIANT_TRAILER.byteLength;

export function isReadonlyMediaAcceptanceSourceSizeAllowed(size: number): boolean {
  return Number.isSafeInteger(size) && size > 0 && size <= READONLY_MEDIA_ACCEPTANCE_MAX_SOURCE_BYTES;
}
