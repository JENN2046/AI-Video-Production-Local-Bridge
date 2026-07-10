import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureM0Directories, paths } from "../paths.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { getGenerationRun } from "./generation.js";
import { getProject, listProjectShots, type Project, type Shot, type ToolError } from "./projects.js";

export const MEMORY_SAVEBACK_STORE_FILE = "data/memory/saveback_store.json";
export const MEMORY_SAVEBACK_REPORT_LATEST = "data/reports/memory_saveback_result.json";

const MEMORY_SAVEBACK_REPORT_STEM = "memory_saveback_result";

export type MemorySavebackItemType = "memory_item" | "asset" | "reference";
export type MemorySavebackItemStatus = "proposed" | "approved" | "rejected";
export type MemorySavebackProposalStatus = "draft" | "reviewed" | "confirmed";

export interface MemoryProvenance {
  project_id: string;
  shot_id: string;
  artifact_id: string;
  run_id: string;
  storyboard_package_id: string;
  report_refs: string[];
  source: "local_app_closeout";
}

export interface MemorySavebackProposalItem {
  item_id: string;
  item_type: MemorySavebackItemType;
  status: MemorySavebackItemStatus;
  title: string;
  content: string;
  tags: string[];
  provenance: MemoryProvenance;
  rejection_reason: string;
}

export interface MemorySavebackProposal {
  proposal_id: string;
  project_id: string;
  project_title: string;
  status: MemorySavebackProposalStatus;
  created_at: string;
  updated_at: string;
  items: MemorySavebackProposalItem[];
  long_term_memory_write_attempted: false;
}

export interface MemoryItem {
  memory_item_id: string;
  title: string;
  content: string;
  tags: string[];
  provenance: MemoryProvenance & {
    proposal_id: string;
    proposal_item_id: string;
  };
  created_at: string;
  status: "local_confirmed";
}

export interface AssetRecord {
  asset_id: string;
  title: string;
  artifact_id: string;
  tags: string[];
  provenance: MemoryProvenance & {
    proposal_id: string;
    proposal_item_id: string;
  };
  created_at: string;
  status: "local_confirmed";
}

export interface ReferenceRecord {
  reference_id: string;
  title: string;
  content: string;
  tags: string[];
  provenance: MemoryProvenance & {
    proposal_id: string;
    proposal_item_id: string;
  };
  created_at: string;
  status: "local_confirmed";
}

export interface MemoryRecallPack {
  recall_pack_id: string;
  project_id: string;
  generated_at: string;
  memory_items: MemoryItem[];
  assets: AssetRecord[];
  references: ReferenceRecord[];
  report_refs: string[];
  boundary: {
    long_term_memory_write_attempted: false;
    secret_read: false;
    private_state_read: false;
    source_asset_overwritten: false;
  };
}

export interface MemorySavebackStore {
  version: "memory-saveback-v0.1";
  updated_at: string;
  proposals: MemorySavebackProposal[];
  memory_items: MemoryItem[];
  assets: AssetRecord[];
  references: ReferenceRecord[];
  recall_packs: MemoryRecallPack[];
}

export type MemorySavebackResult<T> = { ok: true; value: T } | { ok: false; error: ToolError };

export interface MemorySavebackWorkbenchSummary {
  proposals_total: number;
  latest_proposal: MemorySavebackProposal | null;
  memory_items_total: number;
  assets_total: number;
  references_total: number;
  recall_packs_total: number;
  memory_items: MemoryItem[];
  assets: AssetRecord[];
  references: ReferenceRecord[];
  recall_packs: MemoryRecallPack[];
  boundary: {
    automatic_memory_save: false;
    long_term_memory_write_attempted: false;
    secret_read: false;
    private_state_read: false;
    source_asset_overwritten: false;
  };
}

function now(): string {
  return new Date().toISOString();
}

function memoryRoot(): string {
  return join(paths.dataRoot, "memory");
}

function storePath(): string {
  return join(memoryRoot(), "saveback_store.json");
}

function ensureMemoryDirectories(): void {
  ensureM0Directories();
  if (!existsSync(memoryRoot())) mkdirSync(memoryRoot(), { recursive: true });
}

function defaultMemorySavebackStore(): MemorySavebackStore {
  return {
    version: "memory-saveback-v0.1",
    updated_at: now(),
    proposals: [],
    memory_items: [],
    assets: [],
    references: [],
    recall_packs: []
  };
}

function normalizeStore(parsed: Partial<MemorySavebackStore>): MemorySavebackStore {
  return {
    ...defaultMemorySavebackStore(),
    ...parsed,
    version: "memory-saveback-v0.1",
    proposals: parsed.proposals ?? [],
    memory_items: parsed.memory_items ?? [],
    assets: parsed.assets ?? [],
    references: parsed.references ?? [],
    recall_packs: parsed.recall_packs ?? []
  };
}

export function loadMemorySavebackStore(): MemorySavebackStore {
  ensureMemoryDirectories();
  const target = storePath();
  if (!existsSync(target)) return defaultMemorySavebackStore();
  return normalizeStore(JSON.parse(readFileSync(target, "utf8")) as Partial<MemorySavebackStore>);
}

export function saveMemorySavebackStore(store: MemorySavebackStore): MemorySavebackStore {
  ensureMemoryDirectories();
  const next = { ...store, updated_at: now() };
  writeFileSync(storePath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function toolError(code: string, message: string): ToolError {
  return { code, message };
}

function baseProvenance(project: Project, reportRefs: string[]): MemoryProvenance {
  return {
    project_id: project.project_id,
    shot_id: "",
    artifact_id: "",
    run_id: "",
    storyboard_package_id: project.active_storyboard_package_id,
    report_refs: reportRefs,
    source: "local_app_closeout"
  };
}

function shotClipRunId(shot: Shot): string {
  return shot.clip_versions.find((version) => version.artifact_id === shot.accepted_clip_artifact_id)?.run_id ?? shot.generation_run_ids.at(-1) ?? "";
}

function proposalItem(input: {
  item_type: MemorySavebackItemType;
  title: string;
  content: string;
  tags: string[];
  provenance: MemoryProvenance;
}): MemorySavebackProposalItem {
  return {
    item_id: `saveback_item_${randomUUID()}`,
    item_type: input.item_type,
    status: "proposed",
    title: input.title,
    content: input.content,
    tags: input.tags,
    provenance: input.provenance,
    rejection_reason: ""
  };
}

function createProposalItems(project: Project, db: M0Database, reportRefs: string[]): MemorySavebackProposalItem[] {
  const shots = listProjectShots(db, project.project_id);
  const items: MemorySavebackProposalItem[] = [
    proposalItem({
      item_type: "memory_item",
      title: `${project.title} production closeout`,
      content: `Project ${project.project_id} closed with status ${project.status}, ${shots.length} shot(s), final video artifact ${project.exports.final_video_artifact_id || "not assembled"}.`,
      tags: ["project_closeout", project.project_type],
      provenance: baseProvenance(project, reportRefs)
    })
  ];

  for (const shot of shots) {
    if (!shot.accepted_clip_artifact_id) continue;
    const runId = shotClipRunId(shot);
    const run = runId ? getGenerationRun(db, runId) : null;
    items.push(
      proposalItem({
        item_type: "asset",
        title: `Accepted clip for shot ${String(shot.order).padStart(3, "0")}`,
        content: `Accepted generated clip ${shot.accepted_clip_artifact_id} for shot ${shot.shot_id}.`,
        tags: ["accepted_clip", "generated_clip"],
        provenance: {
          ...baseProvenance(project, reportRefs),
          shot_id: shot.shot_id,
          artifact_id: shot.accepted_clip_artifact_id,
          run_id: run?.run_id ?? runId
        }
      })
    );
  }

  if (project.exports.final_video_artifact_id) {
    items.push(
      proposalItem({
        item_type: "asset",
        title: `${project.title} final video`,
        content: `Final assembled video artifact ${project.exports.final_video_artifact_id}.`,
        tags: ["final_video", "assembled_output"],
        provenance: {
          ...baseProvenance(project, reportRefs),
          artifact_id: project.exports.final_video_artifact_id
        }
      })
    );
  }

  if (project.active_storyboard_package_id) {
    items.push(
      proposalItem({
        item_type: "reference",
        title: `${project.title} storyboard package reference`,
        content: `Frozen storyboard package ${project.active_storyboard_package_id} can be used as a future project reference.`,
        tags: ["storyboard_package", "creative_reference"],
        provenance: baseProvenance(project, reportRefs)
      })
    );
  }

  return items;
}

export function createMemorySavebackProposal(
  input: { project_id: string; report_refs?: string[]; write_report?: boolean },
  db = openM0Database(),
  store = loadMemorySavebackStore()
): MemorySavebackResult<{ proposal: MemorySavebackProposal; store: MemorySavebackStore; report: unknown }> {
  const project = getProject(db, input.project_id);
  if (!project) return { ok: false, error: toolError("PROJECT_NOT_FOUND", `Project not found: ${input.project_id}`) };

  const proposal: MemorySavebackProposal = {
    proposal_id: `memory_proposal_${randomUUID()}`,
    project_id: project.project_id,
    project_title: project.title,
    status: "draft",
    created_at: now(),
    updated_at: now(),
    items: createProposalItems(project, db, input.report_refs ?? []),
    long_term_memory_write_attempted: false
  };

  const nextStore = saveMemorySavebackStore({
    ...store,
    proposals: [...store.proposals, proposal]
  });
  const runId = randomUUID();
  const report = {
    task: "R3-6_MEMORY_ASSET_SAVEBACK_CORE",
    action: "create_memory_saveback_proposal",
    result: "PASS",
    run_id: runId,
    generated_at: now(),
    project_id: project.project_id,
    proposal_id: proposal.proposal_id,
    item_count: proposal.items.length,
    provider_boundary: {
      long_term_memory_write_attempted: false,
      secret_read: false,
      private_state_read: false,
      source_asset_overwritten: false
    },
    report_path: `data/reports/${MEMORY_SAVEBACK_REPORT_STEM}_${runId}.json`,
    latest_report_path: MEMORY_SAVEBACK_REPORT_LATEST
  };
  if (input.write_report !== false) writeJsonReport(MEMORY_SAVEBACK_REPORT_STEM, runId, report, MEMORY_SAVEBACK_REPORT_LATEST);

  return { ok: true, value: { proposal, store: nextStore, report } };
}

function itemProvenance(proposal: MemorySavebackProposal, item: MemorySavebackProposalItem): MemoryProvenance & { proposal_id: string; proposal_item_id: string } {
  return {
    ...item.provenance,
    project_id: item.provenance.project_id || proposal.project_id,
    proposal_id: proposal.proposal_id,
    proposal_item_id: item.item_id
  };
}

function alreadyMaterialized(store: MemorySavebackStore, proposalId: string, itemId: string): boolean {
  return [...store.memory_items, ...store.assets, ...store.references].some(
    (record) => record.provenance.proposal_id === proposalId && record.provenance.proposal_item_id === itemId
  );
}

export function confirmMemorySavebackProposal(
  input: {
    proposal_id: string;
    human_confirmation: boolean;
    decisions: Array<{ item_id: string; decision: "approve" | "reject"; title?: string; content?: string; rejection_reason?: string }>;
  },
  store = loadMemorySavebackStore()
): MemorySavebackResult<{ proposal: MemorySavebackProposal; store: MemorySavebackStore; created: { memory_items: MemoryItem[]; assets: AssetRecord[]; references: ReferenceRecord[] } }> {
  if (input.human_confirmation !== true) {
    return { ok: false, error: toolError("HUMAN_CONFIRMATION_REQUIRED", "Memory saveback materialization requires explicit human confirmation.") };
  }

  const proposal = store.proposals.find((candidate) => candidate.proposal_id === input.proposal_id);
  if (!proposal) return { ok: false, error: toolError("PROPOSAL_NOT_FOUND", `Proposal not found: ${input.proposal_id}`) };

  const proposalItemIds = new Set(proposal.items.map((item) => item.item_id));
  const seenDecisionItemIds = new Set<string>();
  for (const decision of input.decisions) {
    if (decision.decision !== "approve" && decision.decision !== "reject") {
      return { ok: false, error: toolError("INVALID_DECISION", "Memory saveback decisions must be approve or reject.") };
    }
    if (!proposalItemIds.has(decision.item_id)) {
      return { ok: false, error: toolError("PROPOSAL_ITEM_NOT_FOUND", `Proposal item not found: ${decision.item_id}`) };
    }
    if (seenDecisionItemIds.has(decision.item_id)) {
      return { ok: false, error: toolError("DUPLICATE_DECISION_ITEM", `Duplicate decision for proposal item: ${decision.item_id}`) };
    }
    seenDecisionItemIds.add(decision.item_id);
  }

  const decisionsByItemId = new Map(input.decisions.map((decision) => [decision.item_id, decision]));
  const created = {
    memory_items: [] as MemoryItem[],
    assets: [] as AssetRecord[],
    references: [] as ReferenceRecord[]
  };
  const nextProposal: MemorySavebackProposal = {
    ...proposal,
    status: "reviewed",
    updated_at: now(),
    items: proposal.items.map((item) => {
      const decision = decisionsByItemId.get(item.item_id);
      if (!decision) return item;
      return {
        ...item,
        status: decision.decision === "approve" ? "approved" : "rejected",
        title: decision.title ?? item.title,
        content: decision.content ?? item.content,
        rejection_reason: decision.decision === "reject" ? decision.rejection_reason ?? "rejected_by_human" : ""
      };
    })
  };

  for (const item of nextProposal.items.filter((candidate) => candidate.status === "approved")) {
    if (alreadyMaterialized(store, proposal.proposal_id, item.item_id)) continue;
    const provenance = itemProvenance(proposal, item);
    if (item.item_type === "memory_item") {
      created.memory_items.push({
        memory_item_id: `memory_item_${randomUUID()}`,
        title: item.title,
        content: item.content,
        tags: item.tags,
        provenance,
        created_at: now(),
        status: "local_confirmed"
      });
    } else if (item.item_type === "asset") {
      created.assets.push({
        asset_id: `asset_${randomUUID()}`,
        title: item.title,
        artifact_id: item.provenance.artifact_id,
        tags: item.tags,
        provenance,
        created_at: now(),
        status: "local_confirmed"
      });
    } else {
      created.references.push({
        reference_id: `reference_${randomUUID()}`,
        title: item.title,
        content: item.content,
        tags: item.tags,
        provenance,
        created_at: now(),
        status: "local_confirmed"
      });
    }
  }

  const nextStatus: MemorySavebackProposalStatus = nextProposal.items.every((item) => item.status === "approved" || item.status === "rejected") ? "confirmed" : "reviewed";
  const confirmedProposal: MemorySavebackProposal = {
    ...nextProposal,
    status: nextStatus,
    updated_at: now()
  };
  const nextStore = saveMemorySavebackStore({
    ...store,
    proposals: store.proposals.map((candidate) => (candidate.proposal_id === proposal.proposal_id ? confirmedProposal : candidate)),
    memory_items: [...store.memory_items, ...created.memory_items],
    assets: [...store.assets, ...created.assets],
    references: [...store.references, ...created.references]
  });

  return { ok: true, value: { proposal: confirmedProposal, store: nextStore, created } };
}

export function generateMemoryRecallPack(input: { project_id: string }, store = loadMemorySavebackStore()): MemorySavebackResult<{ recall_pack: MemoryRecallPack; store: MemorySavebackStore }> {
  const memoryItems = store.memory_items.filter((item) => item.provenance.project_id === input.project_id);
  const assets = store.assets.filter((asset) => asset.provenance.project_id === input.project_id);
  const references = store.references.filter((reference) => reference.provenance.project_id === input.project_id);
  const reportRefs = Array.from(
    new Set([...memoryItems, ...assets, ...references].flatMap((item) => item.provenance.report_refs))
  );
  const recallPack: MemoryRecallPack = {
    recall_pack_id: `recall_pack_${randomUUID()}`,
    project_id: input.project_id,
    generated_at: now(),
    memory_items: memoryItems,
    assets,
    references,
    report_refs: reportRefs,
    boundary: {
      long_term_memory_write_attempted: false,
      secret_read: false,
      private_state_read: false,
      source_asset_overwritten: false
    }
  };
  const nextStore = saveMemorySavebackStore({
    ...store,
    recall_packs: [...store.recall_packs, recallPack]
  });
  return { ok: true, value: { recall_pack: recallPack, store: nextStore } };
}

export function memorySavebackWorkbenchSummary(store = loadMemorySavebackStore()): MemorySavebackWorkbenchSummary {
  const latestProposal = store.proposals.at(-1) ?? null;
  return {
    proposals_total: store.proposals.length,
    latest_proposal: latestProposal,
    memory_items_total: store.memory_items.length,
    assets_total: store.assets.length,
    references_total: store.references.length,
    recall_packs_total: store.recall_packs.length,
    memory_items: store.memory_items.slice(-25).reverse(),
    assets: store.assets.slice(-25).reverse(),
    references: store.references.slice(-25).reverse(),
    recall_packs: store.recall_packs.slice(-10).reverse(),
    boundary: {
      automatic_memory_save: false,
      long_term_memory_write_attempted: false,
      secret_read: false,
      private_state_read: false,
      source_asset_overwritten: false
    }
  };
}

function writeJsonReport(stem: string, runId: string, payload: unknown, latestRelativePath: string): string {
  ensureM0Directories();
  const immutablePath = join(paths.reportsRoot, `${stem}_${runId}.json`);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(immutablePath, text, "utf8");
  writeFileSync(join(paths.workspaceRoot, latestRelativePath), text, "utf8");
  return immutablePath;
}
