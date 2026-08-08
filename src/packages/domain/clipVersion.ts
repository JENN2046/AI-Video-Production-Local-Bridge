import { z } from "zod/v4";

/**
 * Neutral ClipVersion contract shared by WebGPT projections and the T2
 * foundation. Keeping this schema here prevents a second, weaker runtime
 * validator from being introduced by the eligibility work.
 */
export const WEBGPT_V4_CLIP_VERSION_SCHEMA = z.object({
  artifact_id: z.string(),
  run_id: z.string(),
  attempt_number: z.number().int(),
  review_status: z.enum(["pending", "approved", "rejected"])
}).strict();

export type WebGptV4ClipVersion = z.infer<typeof WEBGPT_V4_CLIP_VERSION_SCHEMA>;
