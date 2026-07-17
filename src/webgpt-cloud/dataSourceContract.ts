import type { WebGptV4Detail } from "../webgpt-v4/contracts.js";
import type { WebGptV4Result } from "../webgpt-v4/types.js";

export type ReadonlyProjectListInput = {
  query?: string;
  include_archived?: boolean;
  limit?: number;
  offset?: number;
  detail?: WebGptV4Detail;
};

export type ReadonlyProjectContextInput = {
  project_id: string;
  workspace?: "overview" | "storyboard" | "generation" | "review" | "delivery";
  detail?: WebGptV4Detail;
};

export type ReadonlyShotListInput = {
  project_id: string;
  limit?: number;
  offset?: number;
  detail?: WebGptV4Detail;
};

export type ReadonlyReviewInput = {
  project_id: string;
  shot_id: string;
  artifact_id?: string;
  notes_limit?: number;
  detail?: WebGptV4Detail;
};

export interface ReadonlyDataSource {
  listProductionProjects(input?: ReadonlyProjectListInput, requestIdValue?: string): WebGptV4Result<unknown>;
  getProjectContext(input: ReadonlyProjectContextInput, requestIdValue?: string): WebGptV4Result<unknown>;
  listProjectShots(input: ReadonlyShotListInput, requestIdValue?: string): WebGptV4Result<unknown>;
  getReviewPackage(input: ReadonlyReviewInput, requestIdValue?: string): WebGptV4Result<unknown>;
  getDeliveryStatus(projectId: string, requestIdValue?: string): WebGptV4Result<unknown>;
  getCloseoutEvidence(projectId: string, requestIdValue?: string): WebGptV4Result<unknown>;
}
