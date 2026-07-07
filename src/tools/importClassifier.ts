import { basename, extname, isAbsolute } from "node:path";

export const STORYBOARD_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

export type StoryboardImageImportClass =
  | "storyboard_candidate"
  | "audit_image"
  | "product_reference"
  | "contact_sheet"
  | "pending_or_fake_id"
  | "archive_or_document"
  | "unsupported_image_extension"
  | "unsafe_path";

export interface StoryboardImageImportClassification {
  ok: boolean;
  class: StoryboardImageImportClass;
  reason_code: string;
  message: string;
}

function pendingLike(value: string): boolean {
  const upper = value.toUpperCase();
  return upper.startsWith("PENDING") || upper.includes("PENDING_");
}

export function classifyStoryboardImageImport(filename: string): StoryboardImageImportClassification {
  if (!filename || filename !== basename(filename) || filename.includes("..") || filename.includes("/") || filename.includes("\\") || isAbsolute(filename)) {
    return { ok: false, class: "unsafe_path", reason_code: "STORAGE_PATH_NOT_ALLOWED", message: `Import filename is not allowed: ${filename}` };
  }

  const lower = filename.toLowerCase();
  const extension = extname(filename).toLowerCase();
  if (pendingLike(filename)) {
    return { ok: false, class: "pending_or_fake_id", reason_code: "PENDING_ID_REJECTED", message: "PENDING or fake ids are not accepted as storyboard image imports." };
  }
  if (lower.includes("audit") || lower.includes("failed_layout") || lower.includes("do_not_use")) {
    return { ok: false, class: "audit_image", reason_code: "AUDIT_IMAGE_REJECTED", message: "Audit or failed-layout images cannot be imported as storyboard_image artifacts." };
  }
  if (lower.includes("product_reference") || lower.includes("product-ref") || lower.includes("reference")) {
    return { ok: false, class: "product_reference", reason_code: "PRODUCT_REFERENCE_REJECTED", message: "Product/reference images cannot be imported as storyboard_image artifacts." };
  }
  if (lower.includes("four_panel") || lower.includes("4panel") || lower.includes("4_panel") || lower.includes("contact_sheet") || lower.includes("collage") || lower.includes("storyboard_sheet")) {
    return { ok: false, class: "contact_sheet", reason_code: "FOUR_PANEL_REFERENCE_REJECTED", message: "Contact sheets and storyboard sheets are not single-shot storyboard images." };
  }
  if (extension === ".zip" || [".md", ".txt", ".json", ".yaml", ".yml", ".pdf", ".docx"].includes(extension)) {
    return { ok: false, class: "archive_or_document", reason_code: extension === ".zip" ? "ZIP_FILE_REJECTED" : "DOC_FILE_REJECTED", message: "Archives and documents cannot be imported as storyboard_image artifacts." };
  }
  if (!STORYBOARD_IMAGE_EXTENSIONS.has(extension)) {
    return { ok: false, class: "unsupported_image_extension", reason_code: "IMAGE_EXTENSION_UNSUPPORTED", message: "Storyboard image imports must be PNG or JPEG files." };
  }

  return { ok: true, class: "storyboard_candidate", reason_code: "STORYBOARD_IMAGE_CANDIDATE", message: "Import can be considered as a single-shot storyboard image." };
}

export function isNineSixteenDimensions(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  return Math.abs(width / height - 9 / 16) <= 0.01;
}

export function isNineSixteenAspectRatio(aspectRatio: string): boolean {
  return aspectRatio.trim() === "9:16";
}
