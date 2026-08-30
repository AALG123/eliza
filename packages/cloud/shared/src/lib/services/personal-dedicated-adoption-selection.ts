/**
 * Admin-reviewed selection of one existing personal Dedicated candidate.
 *
 * This boundary is deliberately non-billable: it writes only a durable
 * selection receipt. It never changes the agent row, creates a lifecycle job,
 * starts compute, finalizes personal cutover, or removes another candidate.
 */

import { ElizaError } from "@elizaos/core";
import { and, asc, eq, inArray, notExists, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/helpers";
import type { AgentSandbox, AgentSandboxStatus } from "../../db/repositories/agent-sandboxes";
import { agentSandboxBackups, agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { jobs } from "../../db/schemas/jobs";
import { personalDedicatedAdoptionSelections } from "../../db/schemas/personal-dedicated-adoption-selections";
import { personalDedicatedUpgradeAuthorities } from "../../db/schemas/personal-dedicated-upgrade-authorities";
import { adoptableUnmarkedTargetWhere } from "./agent-tier-upgrade-target";
import {
  configureElizaLifecycleTransaction,
  elizaAgentCreateAdvisoryLockSql,
  elizaAgentTierUpgradeAdvisoryLockSql,
  elizaProvisionAdvisoryLockSql,
} from "./eliza-provision-lock";
import {
  type PersonalDedicatedBackupProvenance,
  type PersonalDedicatedStateDisposition,
  personalDedicatedActivationAuthority,
  personalDedicatedActivationAuthorityFromReceipt,
  personalDedicatedActivationAuthorityKey,
  personalDedicatedActivationAuthorityReceiptColumns,
  personalDedicatedInventoryFingerprint,
  personalDedicatedStateDisposition,
} from "./personal-dedicated-adoption-provenance";
import { EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES } from "./provisioning-job-types";

const MAX_REVIEWABLE_CANDIDATES = 100;
const SELECTION_REASON = "duplicate_owned_dedicated_inventory" as const;

export type PersonalDedicatedSelectionReason = typeof SELECTION_REASON;

export class PersonalDedicatedSelectionError extends ElizaError {
  override readonly name = "PersonalDedicatedSelectionError";
}

export interface PersonalDedicatedSelectionInput {
  organizationId: string;
  userId: string;
  sourceAgentId: string;
  retainedAgentId: string;
  selectedByUserId: string | null;
  reason: PersonalDedicatedSelectionReason;
}

export interface PersonalDedicatedSelectionPreview {
  inventoryFingerprint: string;
  retainedAgentId: string;
  retainedStatus: AgentSandboxStatus;
  retainedLifecycleRevision: number;
  stateDisposition: PersonalDedicatedStateDisposition;
  candidateCount: number;
  alreadySelected: boolean;
  startsCompute: false;
  createsJob: false;
  deletesRows: false;
  changesCutover: false;
}

export interface PersonalDedicatedSelectionExecuteInput extends PersonalDedicatedSelectionInput {
  expectedInventoryFingerprint: string;
  expectedStateDisposition: PersonalDedicatedStateDisposition;
}

export interface PersonalDedicatedSelectionReviewInput {
  organizationId: string;
  userId: string;
  sourceAgentId: string;
}

export interface PersonalDedicatedSelectionReviewPreview {
  currentInventoryFingerprint: string;
  receiptInventoryFingerprint: string;
  receiptUpdatedAt: string;
  retainedStatus: AgentSandboxStatus;
  retainedLifecycleRevision: number;
  stateDisposition: PersonalDedicatedStateDisposition;
  candidateCount: number;
  receiptCurrent: boolean;
  startsCompute: false;
  createsJob: false;
  deletesRows: false;
  changesCutover: false;
}

export interface PersonalDedicatedSelectionReviewExecuteInput
  extends PersonalDedicatedSelectionReviewInput {
  expectedReceiptInventoryFingerprint: string;
  expectedReceiptUpdatedAt: string;
  expectedCurrentInventoryFingerprint: string;
  expectedCurrentStateDisposition: PersonalDedicatedStateDisposition;
  expectedCurrentCandidateCount: number;
}

function selectionError(
  code:
    | "PERSONAL_DEDICATED_SELECTION_NOT_FOUND"
    | "PERSONAL_DEDICATED_SELECTION_NOT_AMBIGUOUS"
    | "PERSONAL_DEDICATED_SELECTION_CONFLICT"
    | "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED"
    | "PERSONAL_DEDICATED_SELECTION_ACTIVE_JOB",
  message: string,
  params: Pick<PersonalDedicatedSelectionInput, "organizationId" | "userId" | "sourceAgentId"> &
    Partial<Pick<PersonalDedicatedSelectionInput, "retainedAgentId">>,
): PersonalDedicatedSelectionError {
  return new PersonalDedicatedSelectionError(message, {
    code,
    context: {
      organizationId: params.organizationId,
      userId: params.userId,
      sourceAgentId: params.sourceAgentId,
      retainedAgentId: params.retainedAgentId,
    },
  });
}

function selectionReviewError(
  code:
    | "PERSONAL_DEDICATED_SELECTION_NOT_FOUND"
    | "PERSONAL_DEDICATED_SELECTION_NOT_AMBIGUOUS"
    | "PERSONAL_DEDICATED_SELECTION_CONFLICT"
    | "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED"
    | "PERSONAL_DEDICATED_SELECTION_ACTIVE_JOB",
  message: string,
  params: PersonalDedicatedSelectionReviewInput,
  retainedAgentId?: string,
): PersonalDedicatedSelectionError {
  return selectionError(code, message, { ...params, retainedAgentId });
}

function unselectedCandidateWhere(organizationId: string, userId: string) {
  return and(
    adoptableUnmarkedTargetWhere(organizationId, userId),
    notExists(
      dbWrite
        .select({ id: personalDedicatedAdoptionSelections.id })
        .from(personalDedicatedAdoptionSelections)
        .where(eq(personalDedicatedAdoptionSelections.dedicated_agent_id, agentSandboxes.id)),
    ),
  );
}

const backupProvenanceProjection = {
  id: agentSandboxBackups.id,
  sandboxRecordId: agentSandboxBackups.sandbox_record_id,
  snapshotType: agentSandboxBackups.snapshot_type,
  stateDataStorage: agentSandboxBackups.state_data_storage,
  stateDataKey: agentSandboxBackups.state_data_key,
  backupKind: agentSandboxBackups.backup_kind,
  parentBackupId: agentSandboxBackups.parent_backup_id,
  contentHash: agentSandboxBackups.content_hash,
  verificationStatus: agentSandboxBackups.verification_status,
  verifiedAt: agentSandboxBackups.verified_at,
  catalogVersion: agentSandboxBackups.catalog_version,
  catalogState: agentSandboxBackups.catalog_state,
  catalogPayloadDigest: agentSandboxBackups.catalog_payload_digest,
  catalogRevision: agentSandboxBackups.catalog_revision,
  catalogOrganizationId: agentSandboxBackups.catalog_organization_id,
  catalogAgentId: agentSandboxBackups.catalog_agent_id,
  sourceProvider: agentSandboxBackups.source_provider,
  sourceNodeRecordId: agentSandboxBackups.source_node_record_id,
  sourceNodeId: agentSandboxBackups.source_node_id,
  sourceProviderServerId: agentSandboxBackups.source_provider_server_id,
  sourceProviderHandle: agentSandboxBackups.source_provider_handle,
  sourceContainerId: agentSandboxBackups.source_container_id,
  manifestVersion: agentSandboxBackups.manifest_version,
  manifestDigest: agentSandboxBackups.manifest_digest,
  objectInventoryDigest: agentSandboxBackups.object_inventory_digest,
  imageDigest: agentSandboxBackups.image_digest,
  databaseSchemaVersion: agentSandboxBackups.database_schema_version,
  pluginSetDigest: agentSandboxBackups.plugin_set_digest,
  watermarkDigest: agentSandboxBackups.watermark_digest,
  restoreReceiptDigest: agentSandboxBackups.restore_receipt_digest,
  catalogDeletedAt: agentSandboxBackups.catalog_deleted_at,
  createdAt: agentSandboxBackups.created_at,
};

async function readBackupProvenance(candidateIds: string[]) {
  if (candidateIds.length === 0) return [];
  return (await dbWrite
    .select(backupProvenanceProjection)
    .from(agentSandboxBackups)
    .where(inArray(agentSandboxBackups.sandbox_record_id, candidateIds))
    .orderBy(
      asc(agentSandboxBackups.sandbox_record_id),
      asc(agentSandboxBackups.id),
    )) as PersonalDedicatedBackupProvenance[];
}

async function readBackupProvenanceInTx(tx: DbTransaction, candidateIds: string[]) {
  if (candidateIds.length === 0) return [];
  return (await tx
    .select(backupProvenanceProjection)
    .from(agentSandboxBackups)
    .where(inArray(agentSandboxBackups.sandbox_record_id, candidateIds))
    .orderBy(asc(agentSandboxBackups.sandbox_record_id), asc(agentSandboxBackups.id))
    .for("share")) as PersonalDedicatedBackupProvenance[];
}

async function findSelection(params: PersonalDedicatedSelectionInput) {
  const [selection] = await dbWrite
    .select()
    .from(personalDedicatedAdoptionSelections)
    .where(
      and(
        eq(personalDedicatedAdoptionSelections.organization_id, params.organizationId),
        eq(personalDedicatedAdoptionSelections.user_id, params.userId),
        eq(personalDedicatedAdoptionSelections.source_agent_id, params.sourceAgentId),
      ),
    )
    .limit(1);
  return selection ?? null;
}

async function findAuthority(params: PersonalDedicatedSelectionInput) {
  const [authority] = await dbWrite
    .select({ id: personalDedicatedUpgradeAuthorities.id })
    .from(personalDedicatedUpgradeAuthorities)
    .where(
      and(
        eq(personalDedicatedUpgradeAuthorities.organization_id, params.organizationId),
        eq(personalDedicatedUpgradeAuthorities.user_id, params.userId),
        eq(personalDedicatedUpgradeAuthorities.source_agent_id, params.sourceAgentId),
      ),
    )
    .limit(1);
  return authority ?? null;
}

async function readUnselectedCandidates(
  params: PersonalDedicatedSelectionInput,
): Promise<AgentSandbox[]> {
  return await dbWrite
    .select()
    .from(agentSandboxes)
    .where(unselectedCandidateWhere(params.organizationId, params.userId))
    .orderBy(asc(agentSandboxes.id))
    .limit(MAX_REVIEWABLE_CANDIDATES + 1);
}

async function findActiveCandidateLifecycleJob(
  query: Pick<DbTransaction, "select"> | typeof dbWrite,
  organizationId: string,
  candidateIds: string[],
) {
  if (candidateIds.length === 0) return null;
  const [job] = await query
    .select({ id: jobs.id, type: jobs.type })
    .from(jobs)
    .where(
      and(
        eq(jobs.organization_id, organizationId),
        inArray(jobs.agent_id, candidateIds),
        inArray(jobs.type, [...EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES]),
        sql`${jobs.status} IN ('pending', 'in_progress')`,
      ),
    )
    .limit(1);
  return job ?? null;
}

function assertStableAmbiguousInventory(
  params: PersonalDedicatedSelectionInput,
  candidates: AgentSandbox[],
): AgentSandbox {
  if (candidates.length > MAX_REVIEWABLE_CANDIDATES) {
    throw selectionError(
      "PERSONAL_DEDICATED_SELECTION_CONFLICT",
      "The Dedicated inventory exceeds the bounded review limit",
      params,
    );
  }
  const retained = candidates.find((candidate) => candidate.id === params.retainedAgentId);
  if (!retained) {
    throw selectionError(
      "PERSONAL_DEDICATED_SELECTION_NOT_FOUND",
      "The retained Dedicated candidate was not found",
      params,
    );
  }
  if (candidates.length < 2) {
    throw selectionError(
      "PERSONAL_DEDICATED_SELECTION_NOT_AMBIGUOUS",
      "The owner inventory does not contain multiple eligible Dedicated candidates",
      params,
    );
  }
  return retained;
}

function previewFromSelection(
  params: PersonalDedicatedSelectionInput,
  selection: typeof personalDedicatedAdoptionSelections.$inferSelect,
  retained: AgentSandbox,
): PersonalDedicatedSelectionPreview {
  if (selection.dedicated_agent_id !== params.retainedAgentId) {
    throw selectionError(
      "PERSONAL_DEDICATED_SELECTION_CONFLICT",
      "A different Dedicated candidate is already selected for this owner",
      params,
    );
  }
  return {
    inventoryFingerprint: selection.inventory_fingerprint,
    retainedAgentId: retained.id,
    retainedStatus: retained.status,
    retainedLifecycleRevision: retained.lifecycle_revision,
    stateDisposition: selection.state_disposition as PersonalDedicatedStateDisposition,
    candidateCount: selection.candidate_count,
    alreadySelected: true,
    startsCompute: false,
    createsJob: false,
    deletesRows: false,
    changesCutover: false,
  };
}

export async function previewPersonalDedicatedSelection(
  params: PersonalDedicatedSelectionInput,
): Promise<PersonalDedicatedSelectionPreview> {
  const existing = await findSelection(params);
  if (existing) {
    if (existing.dedicated_agent_id !== params.retainedAgentId) {
      throw selectionError(
        "PERSONAL_DEDICATED_SELECTION_CONFLICT",
        "A different Dedicated candidate is already selected for this owner",
        params,
      );
    }
    const [retained] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, existing.dedicated_agent_id),
          adoptableUnmarkedTargetWhere(params.organizationId, params.userId),
        ),
      )
      .limit(1);
    if (!retained) {
      throw selectionError(
        "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
        "The selected Dedicated candidate is no longer eligible",
        params,
      );
    }
    const candidates = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(adoptableUnmarkedTargetWhere(params.organizationId, params.userId))
      .orderBy(asc(agentSandboxes.id))
      .limit(MAX_REVIEWABLE_CANDIDATES + 1);
    const backups = await readBackupProvenance(candidates.map((candidate) => candidate.id));
    const currentFingerprint = await personalDedicatedInventoryFingerprint({
      ...params,
      retainedAgentId: existing.dedicated_agent_id,
      candidates,
      backups,
    });
    const currentActivationAuthority = personalDedicatedActivationAuthority(
      params.organizationId,
      retained.id,
      backups,
    );
    const receiptActivationAuthority = personalDedicatedActivationAuthorityFromReceipt(
      existing.activation_kind,
      existing.activation_backup_id,
      existing.activation_backup_hash,
      existing.activation_backup_chain,
    );
    if (
      candidates.length !== existing.candidate_count ||
      currentFingerprint !== existing.inventory_fingerprint ||
      personalDedicatedStateDisposition(params.organizationId, retained.id, backups) !==
        existing.state_disposition ||
      personalDedicatedActivationAuthorityKey(currentActivationAuthority) !==
        personalDedicatedActivationAuthorityKey(receiptActivationAuthority)
    ) {
      throw selectionError(
        "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
        "The selected Dedicated state provenance changed after review",
        params,
      );
    }
    const activeJob = await findActiveCandidateLifecycleJob(
      dbWrite,
      params.organizationId,
      candidates.map((candidate) => candidate.id),
    );
    if (activeJob) {
      throw selectionError(
        "PERSONAL_DEDICATED_SELECTION_ACTIVE_JOB",
        "The reviewed Dedicated inventory has active lifecycle work",
        params,
      );
    }
    return previewFromSelection(params, existing, retained);
  }
  if (await findAuthority(params)) {
    throw selectionError(
      "PERSONAL_DEDICATED_SELECTION_CONFLICT",
      "This personal Dedicated source is already adopted",
      params,
    );
  }

  const candidates = await readUnselectedCandidates(params);
  const retained = assertStableAmbiguousInventory(params, candidates);
  const activeJob = await findActiveCandidateLifecycleJob(
    dbWrite,
    params.organizationId,
    candidates.map((candidate) => candidate.id),
  );
  if (activeJob) {
    throw selectionError(
      "PERSONAL_DEDICATED_SELECTION_ACTIVE_JOB",
      "The reviewed Dedicated inventory has active lifecycle work",
      params,
    );
  }
  const backups = await readBackupProvenance(candidates.map((candidate) => candidate.id));
  const stateDisposition = personalDedicatedStateDisposition(
    params.organizationId,
    retained.id,
    backups,
  );
  return {
    inventoryFingerprint: await personalDedicatedInventoryFingerprint({
      ...params,
      candidates,
      backups,
    }),
    retainedAgentId: retained.id,
    retainedStatus: retained.status,
    retainedLifecycleRevision: retained.lifecycle_revision,
    stateDisposition,
    candidateCount: candidates.length,
    alreadySelected: false,
    startsCompute: false,
    createsJob: false,
    deletesRows: false,
    changesCutover: false,
  };
}

async function readCandidatesInTx(
  tx: DbTransaction,
  params: PersonalDedicatedSelectionInput,
): Promise<AgentSandbox[]> {
  return await tx
    .select()
    .from(agentSandboxes)
    .where(unselectedCandidateWhere(params.organizationId, params.userId))
    .orderBy(asc(agentSandboxes.id))
    .limit(MAX_REVIEWABLE_CANDIDATES + 1)
    .for("update");
}

async function readCurrentEligibleCandidatesInTx(
  tx: DbTransaction,
  params: PersonalDedicatedSelectionInput,
): Promise<AgentSandbox[]> {
  const unlockedCandidates = await tx
    .select({ id: agentSandboxes.id })
    .from(agentSandboxes)
    .where(adoptableUnmarkedTargetWhere(params.organizationId, params.userId))
    .orderBy(asc(agentSandboxes.id))
    .limit(MAX_REVIEWABLE_CANDIDATES + 1);
  for (const candidate of unlockedCandidates) {
    await tx.execute(elizaProvisionAdvisoryLockSql(params.organizationId, candidate.id));
  }
  return await tx
    .select()
    .from(agentSandboxes)
    .where(adoptableUnmarkedTargetWhere(params.organizationId, params.userId))
    .orderBy(asc(agentSandboxes.id))
    .limit(MAX_REVIEWABLE_CANDIDATES + 1)
    .for("update");
}

export async function executePersonalDedicatedSelection(
  params: PersonalDedicatedSelectionExecuteInput,
): Promise<PersonalDedicatedSelectionPreview> {
  let committed: PersonalDedicatedSelectionPreview | undefined;
  try {
    return await dbWrite.transaction(async (tx) => {
      await configureElizaLifecycleTransaction(tx);
      await tx.execute(elizaAgentCreateAdvisoryLockSql(params.organizationId));
      await tx.execute(
        elizaAgentTierUpgradeAdvisoryLockSql(params.organizationId, params.sourceAgentId),
      );

      const [existing] = await tx
        .select()
        .from(personalDedicatedAdoptionSelections)
        .where(
          and(
            eq(personalDedicatedAdoptionSelections.organization_id, params.organizationId),
            eq(personalDedicatedAdoptionSelections.user_id, params.userId),
            eq(personalDedicatedAdoptionSelections.source_agent_id, params.sourceAgentId),
          ),
        )
        .limit(1)
        .for("update");
      if (existing) {
        if (
          existing.inventory_fingerprint !== params.expectedInventoryFingerprint ||
          existing.state_disposition !== params.expectedStateDisposition
        ) {
          throw selectionError(
            "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
            "The Dedicated selection decision does not match the durable receipt",
            params,
          );
        }
        const candidates = await readCurrentEligibleCandidatesInTx(tx, params);
        const retained = candidates.find(
          (candidate) => candidate.id === existing.dedicated_agent_id,
        );
        if (!retained || candidates.length !== existing.candidate_count) {
          throw selectionError(
            "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
            "The selected Dedicated candidate is no longer eligible",
            params,
          );
        }
        const backups = await readBackupProvenanceInTx(
          tx,
          candidates.map((candidate) => candidate.id),
        );
        const currentFingerprint = await personalDedicatedInventoryFingerprint({
          ...params,
          retainedAgentId: existing.dedicated_agent_id,
          candidates,
          backups,
        });
        const currentActivationAuthority = personalDedicatedActivationAuthority(
          params.organizationId,
          retained.id,
          backups,
        );
        const receiptActivationAuthority = personalDedicatedActivationAuthorityFromReceipt(
          existing.activation_kind,
          existing.activation_backup_id,
          existing.activation_backup_hash,
          existing.activation_backup_chain,
        );
        if (
          currentFingerprint !== existing.inventory_fingerprint ||
          currentFingerprint !== params.expectedInventoryFingerprint ||
          personalDedicatedStateDisposition(params.organizationId, retained.id, backups) !==
            existing.state_disposition ||
          personalDedicatedActivationAuthorityKey(currentActivationAuthority) !==
            personalDedicatedActivationAuthorityKey(receiptActivationAuthority)
        ) {
          throw selectionError(
            "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
            "The selected Dedicated state provenance changed after review",
            params,
          );
        }
        const activeJob = await findActiveCandidateLifecycleJob(
          tx,
          params.organizationId,
          candidates.map((candidate) => candidate.id),
        );
        if (activeJob) {
          throw selectionError(
            "PERSONAL_DEDICATED_SELECTION_ACTIVE_JOB",
            "The reviewed Dedicated inventory has active lifecycle work",
            params,
          );
        }
        committed = previewFromSelection(params, existing, retained);
        return committed;
      }

      const [authority] = await tx
        .select({ id: personalDedicatedUpgradeAuthorities.id })
        .from(personalDedicatedUpgradeAuthorities)
        .where(
          and(
            eq(personalDedicatedUpgradeAuthorities.organization_id, params.organizationId),
            eq(personalDedicatedUpgradeAuthorities.user_id, params.userId),
            eq(personalDedicatedUpgradeAuthorities.source_agent_id, params.sourceAgentId),
          ),
        )
        .limit(1)
        .for("update");
      if (authority) {
        throw selectionError(
          "PERSONAL_DEDICATED_SELECTION_CONFLICT",
          "This personal Dedicated source is already adopted",
          params,
        );
      }

      const unlockedCandidates = await tx
        .select({ id: agentSandboxes.id })
        .from(agentSandboxes)
        .where(unselectedCandidateWhere(params.organizationId, params.userId))
        .orderBy(asc(agentSandboxes.id))
        .limit(MAX_REVIEWABLE_CANDIDATES + 1);
      for (const candidate of unlockedCandidates) {
        await tx.execute(elizaProvisionAdvisoryLockSql(params.organizationId, candidate.id));
      }

      const candidates = await readCandidatesInTx(tx, params);
      const retained = assertStableAmbiguousInventory(params, candidates);
      const backups = await readBackupProvenanceInTx(
        tx,
        candidates.map((candidate) => candidate.id),
      );
      const currentFingerprint = await personalDedicatedInventoryFingerprint({
        ...params,
        candidates,
        backups,
      });
      if (currentFingerprint !== params.expectedInventoryFingerprint) {
        throw selectionError(
          "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
          "The Dedicated inventory changed after review",
          params,
        );
      }
      const stateDisposition = personalDedicatedStateDisposition(
        params.organizationId,
        retained.id,
        backups,
      );
      const activationAuthority = personalDedicatedActivationAuthority(
        params.organizationId,
        retained.id,
        backups,
      );
      if (stateDisposition !== params.expectedStateDisposition) {
        throw selectionError(
          "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
          "The retained Dedicated state provenance changed after review",
          params,
        );
      }
      const activeJob = await findActiveCandidateLifecycleJob(
        tx,
        params.organizationId,
        candidates.map((candidate) => candidate.id),
      );
      if (activeJob) {
        throw selectionError(
          "PERSONAL_DEDICATED_SELECTION_ACTIVE_JOB",
          "The reviewed Dedicated inventory has active lifecycle work",
          params,
        );
      }

      await tx.insert(personalDedicatedAdoptionSelections).values({
        organization_id: params.organizationId,
        user_id: params.userId,
        source_agent_id: params.sourceAgentId,
        dedicated_agent_id: params.retainedAgentId,
        selected_by_user_id: params.selectedByUserId,
        selection_reason: params.reason,
        state_disposition: stateDisposition,
        ...personalDedicatedActivationAuthorityReceiptColumns(activationAuthority),
        inventory_fingerprint: currentFingerprint,
        candidate_count: candidates.length,
        schema_version: 1,
      });

      committed = {
        inventoryFingerprint: currentFingerprint,
        retainedAgentId: retained.id,
        retainedStatus: retained.status,
        retainedLifecycleRevision: retained.lifecycle_revision,
        stateDisposition,
        candidateCount: candidates.length,
        alreadySelected: false,
        startsCompute: false,
        createsJob: false,
        deletesRows: false,
        changesCutover: false,
      };
      return committed;
    });
  } catch (error) {
    // error-policy:J1 a lost commit acknowledgement is classified by a fresh
    // full-inventory replay, not by receipt presence alone. No cleanup is
    // needed because no external work ran.
    if (committed) {
      try {
        const durable = await previewPersonalDedicatedSelection(params);
        if (
          durable.alreadySelected &&
          durable.retainedAgentId === params.retainedAgentId &&
          durable.inventoryFingerprint === params.expectedInventoryFingerprint &&
          durable.stateDisposition === params.expectedStateDisposition &&
          durable.candidateCount === committed.candidateCount
        ) {
          return durable;
        }
      } catch {
        // Preserve the original ambiguous boundary rejection when fresh
        // inventory authority cannot prove the exact committed decision.
      }
    }
    throw error;
  }
}

function assertReviewableSelectedInventory(
  params: PersonalDedicatedSelectionReviewInput,
  selection: typeof personalDedicatedAdoptionSelections.$inferSelect,
  candidates: AgentSandbox[],
): AgentSandbox {
  if (selection.restore_fence_hash || selection.restore_fence_started_at) {
    throw selectionReviewError(
      "PERSONAL_DEDICATED_SELECTION_CONFLICT",
      "The selected Dedicated receipt has active restore ownership",
      params,
      selection.dedicated_agent_id,
    );
  }
  if (candidates.length > MAX_REVIEWABLE_CANDIDATES) {
    throw selectionReviewError(
      "PERSONAL_DEDICATED_SELECTION_CONFLICT",
      "The Dedicated inventory exceeds the bounded review limit",
      params,
      selection.dedicated_agent_id,
    );
  }
  const retained = candidates.find((candidate) => candidate.id === selection.dedicated_agent_id);
  if (!retained) {
    throw selectionReviewError(
      "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
      "The selected Dedicated candidate is no longer eligible",
      params,
      selection.dedicated_agent_id,
    );
  }
  if (candidates.length < 2) {
    throw selectionReviewError(
      "PERSONAL_DEDICATED_SELECTION_NOT_AMBIGUOUS",
      "The owner inventory no longer contains multiple eligible Dedicated candidates",
      params,
      selection.dedicated_agent_id,
    );
  }
  return retained;
}

function selectedReceiptIsCurrent(
  params: PersonalDedicatedSelectionReviewInput,
  selection: typeof personalDedicatedAdoptionSelections.$inferSelect,
  retained: AgentSandbox,
  candidates: AgentSandbox[],
  backups: PersonalDedicatedBackupProvenance[],
  currentInventoryFingerprint: string,
): boolean {
  const currentActivationAuthority = personalDedicatedActivationAuthority(
    params.organizationId,
    retained.id,
    backups,
  );
  const receiptActivationAuthority = personalDedicatedActivationAuthorityFromReceipt(
    selection.activation_kind,
    selection.activation_backup_id,
    selection.activation_backup_hash,
    selection.activation_backup_chain,
  );
  return (
    candidates.length === selection.candidate_count &&
    currentInventoryFingerprint === selection.inventory_fingerprint &&
    personalDedicatedStateDisposition(params.organizationId, retained.id, backups) ===
      selection.state_disposition &&
    personalDedicatedActivationAuthorityKey(currentActivationAuthority) ===
      personalDedicatedActivationAuthorityKey(receiptActivationAuthority)
  );
}

async function assertNoExistingUpgradeAuthority(
  query: Pick<DbTransaction, "select"> | typeof dbWrite,
  params: PersonalDedicatedSelectionReviewInput,
): Promise<void> {
  const [authority] = await query
    .select({ id: personalDedicatedUpgradeAuthorities.id })
    .from(personalDedicatedUpgradeAuthorities)
    .where(
      and(
        eq(personalDedicatedUpgradeAuthorities.organization_id, params.organizationId),
        eq(personalDedicatedUpgradeAuthorities.user_id, params.userId),
        eq(personalDedicatedUpgradeAuthorities.source_agent_id, params.sourceAgentId),
      ),
    )
    .limit(1);
  if (authority) {
    throw selectionReviewError(
      "PERSONAL_DEDICATED_SELECTION_CONFLICT",
      "This personal Dedicated source is already adopted",
      params,
    );
  }
}

function selectionReviewPreview(
  params: PersonalDedicatedSelectionReviewInput,
  selection: typeof personalDedicatedAdoptionSelections.$inferSelect,
  retained: AgentSandbox,
  candidates: AgentSandbox[],
  backups: PersonalDedicatedBackupProvenance[],
  currentInventoryFingerprint: string,
  receiptUpdatedAt = selection.updated_at,
): PersonalDedicatedSelectionReviewPreview {
  return {
    currentInventoryFingerprint,
    receiptInventoryFingerprint: selection.inventory_fingerprint,
    receiptUpdatedAt: receiptUpdatedAt.toISOString(),
    retainedStatus: retained.status,
    retainedLifecycleRevision: retained.lifecycle_revision,
    stateDisposition: personalDedicatedStateDisposition(
      params.organizationId,
      retained.id,
      backups,
    ),
    candidateCount: candidates.length,
    receiptCurrent: selectedReceiptIsCurrent(
      params,
      selection,
      retained,
      candidates,
      backups,
      currentInventoryFingerprint,
    ),
    startsCompute: false,
    createsJob: false,
    deletesRows: false,
    changesCutover: false,
  };
}

/** Recomputes the current review facts for the already selected target. */
export async function previewPersonalDedicatedSelectionReview(
  params: PersonalDedicatedSelectionReviewInput,
): Promise<PersonalDedicatedSelectionReviewPreview> {
  const [selection] = await dbWrite
    .select()
    .from(personalDedicatedAdoptionSelections)
    .where(
      and(
        eq(personalDedicatedAdoptionSelections.organization_id, params.organizationId),
        eq(personalDedicatedAdoptionSelections.user_id, params.userId),
        eq(personalDedicatedAdoptionSelections.source_agent_id, params.sourceAgentId),
        eq(personalDedicatedAdoptionSelections.schema_version, 1),
      ),
    )
    .limit(1);
  if (!selection) {
    throw selectionReviewError(
      "PERSONAL_DEDICATED_SELECTION_NOT_FOUND",
      "No existing Dedicated selection receipt was found",
      params,
    );
  }
  await assertNoExistingUpgradeAuthority(dbWrite, params);
  const candidates = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(adoptableUnmarkedTargetWhere(params.organizationId, params.userId))
    .orderBy(asc(agentSandboxes.id))
    .limit(MAX_REVIEWABLE_CANDIDATES + 1);
  const retained = assertReviewableSelectedInventory(params, selection, candidates);
  const activeJob = await findActiveCandidateLifecycleJob(
    dbWrite,
    params.organizationId,
    candidates.map((candidate) => candidate.id),
  );
  if (activeJob) {
    throw selectionReviewError(
      "PERSONAL_DEDICATED_SELECTION_ACTIVE_JOB",
      "The reviewed Dedicated inventory has active lifecycle work",
      params,
      selection.dedicated_agent_id,
    );
  }
  const backups = await readBackupProvenance(candidates.map((candidate) => candidate.id));
  const currentInventoryFingerprint = await personalDedicatedInventoryFingerprint({
    ...params,
    retainedAgentId: selection.dedicated_agent_id,
    candidates,
    backups,
  });
  return selectionReviewPreview(
    params,
    selection,
    retained,
    candidates,
    backups,
    currentInventoryFingerprint,
  );
}

/** Refreshes only the review fields of the existing selection receipt. */
export async function executePersonalDedicatedSelectionReview(
  params: PersonalDedicatedSelectionReviewExecuteInput,
): Promise<PersonalDedicatedSelectionReviewPreview> {
  return await dbWrite.transaction(async (tx) => {
    await configureElizaLifecycleTransaction(tx);
    await tx.execute(elizaAgentCreateAdvisoryLockSql(params.organizationId));
    await tx.execute(
      elizaAgentTierUpgradeAdvisoryLockSql(params.organizationId, params.sourceAgentId),
    );

    const [selection] = await tx
      .select()
      .from(personalDedicatedAdoptionSelections)
      .where(
        and(
          eq(personalDedicatedAdoptionSelections.organization_id, params.organizationId),
          eq(personalDedicatedAdoptionSelections.user_id, params.userId),
          eq(personalDedicatedAdoptionSelections.source_agent_id, params.sourceAgentId),
          eq(personalDedicatedAdoptionSelections.schema_version, 1),
        ),
      )
      .limit(1)
      .for("update");
    if (!selection) {
      throw selectionReviewError(
        "PERSONAL_DEDICATED_SELECTION_NOT_FOUND",
        "No existing Dedicated selection receipt was found",
        params,
      );
    }
    if (
      selection.inventory_fingerprint !== params.expectedReceiptInventoryFingerprint ||
      selection.updated_at.toISOString() !== params.expectedReceiptUpdatedAt
    ) {
      throw selectionReviewError(
        "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
        "The Dedicated selection receipt changed after review",
        params,
        selection.dedicated_agent_id,
      );
    }
    await assertNoExistingUpgradeAuthority(tx, params);

    const candidates = await readCurrentEligibleCandidatesInTx(tx, {
      ...params,
      retainedAgentId: selection.dedicated_agent_id,
      selectedByUserId: selection.selected_by_user_id,
      reason: SELECTION_REASON,
    });
    const retained = assertReviewableSelectedInventory(params, selection, candidates);
    const backups = await readBackupProvenanceInTx(
      tx,
      candidates.map((candidate) => candidate.id),
    );
    const currentInventoryFingerprint = await personalDedicatedInventoryFingerprint({
      ...params,
      retainedAgentId: selection.dedicated_agent_id,
      candidates,
      backups,
    });
    const stateDisposition = personalDedicatedStateDisposition(
      params.organizationId,
      retained.id,
      backups,
    );
    if (
      currentInventoryFingerprint !== params.expectedCurrentInventoryFingerprint ||
      stateDisposition !== params.expectedCurrentStateDisposition ||
      candidates.length !== params.expectedCurrentCandidateCount
    ) {
      throw selectionReviewError(
        "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
        "The Dedicated inventory changed after review",
        params,
        selection.dedicated_agent_id,
      );
    }
    const activeJob = await findActiveCandidateLifecycleJob(
      tx,
      params.organizationId,
      candidates.map((candidate) => candidate.id),
    );
    if (activeJob) {
      throw selectionReviewError(
        "PERSONAL_DEDICATED_SELECTION_ACTIVE_JOB",
        "The reviewed Dedicated inventory has active lifecycle work",
        params,
        selection.dedicated_agent_id,
      );
    }

    const activationAuthority = personalDedicatedActivationAuthority(
      params.organizationId,
      retained.id,
      backups,
    );
    const updatedAt = new Date();
    await tx
      .update(personalDedicatedAdoptionSelections)
      .set({
        state_disposition: stateDisposition,
        ...personalDedicatedActivationAuthorityReceiptColumns(activationAuthority),
        inventory_fingerprint: currentInventoryFingerprint,
        candidate_count: candidates.length,
        updated_at: updatedAt,
      })
      .where(eq(personalDedicatedAdoptionSelections.id, selection.id));

    const refreshedSelection = {
      ...selection,
      state_disposition: stateDisposition,
      ...personalDedicatedActivationAuthorityReceiptColumns(activationAuthority),
      inventory_fingerprint: currentInventoryFingerprint,
      candidate_count: candidates.length,
      updated_at: updatedAt,
    };
    return selectionReviewPreview(
      params,
      refreshedSelection,
      retained,
      candidates,
      backups,
      currentInventoryFingerprint,
      updatedAt,
    );
  });
}

export const personalDedicatedAdoptionSelectionService = {
  preview: previewPersonalDedicatedSelection,
  execute: executePersonalDedicatedSelection,
  previewReview: previewPersonalDedicatedSelectionReview,
  executeReview: executePersonalDedicatedSelectionReview,
};
