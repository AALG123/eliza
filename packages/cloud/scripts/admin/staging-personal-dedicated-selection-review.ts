/**
 * Re-reviews the existing staging smoke owner's Dedicated selection receipt.
 *
 * The workflow-owned API key identifies the owner without operator-supplied
 * coordinates. Dry-run is the default; apply updates only receipt review
 * fields through the shared service and emits an allowlisted privacy-safe
 * result.
 */

import { createHash } from "node:crypto";
import type { PersonalDedicatedSelectionReviewPreview } from "../../shared/src/lib/services/personal-dedicated-adoption-selection";

export const STAGING_SELECTION_REVIEW_CONFIRMATION =
  "refresh_without_provisioning_billing_cutover_or_deletion";

export type StagingSelectionReviewMode = "dry-run" | "apply";

interface StagingSelectionReviewEnvironment {
  DATABASE_URL?: string;
  ELIZAOS_CLOUD_API_KEY?: string;
  ELIZA_CLOUD_ENVIRONMENT?: string;
  GITHUB_ACTIONS?: string;
  GITHUB_EVENT_NAME?: string;
  GITHUB_REF?: string;
  GITHUB_REPOSITORY?: string;
  STAGING_SELECTION_REVIEW_CONFIRMATION?: string;
  STAGING_SELECTION_REVIEW_MODE?: string;
}

export interface StagingSelectionReviewReport {
  schemaVersion: 1;
  environment: "staging";
  mode: StagingSelectionReviewMode;
  outcome: "reviewed" | "refreshed";
  receiptState: "current" | "stale";
  retainedStatus: string;
  stateDisposition: "verified_backup_present" | "fresh_boot_no_verified_backup";
  candidateCount: number;
  invariants: {
    existingSelectionRequired: true;
    serverOwnedTargetRetained: true;
    startsCompute: false;
    createsJob: false;
    deletesRows: false;
    changesCutover: false;
    changesBillingOrCredits: false;
  };
}

function requiredExact(
  value: string | undefined,
  expected: string,
  label: string,
): void {
  if (value !== expected) throw new Error(`${label}_invalid`);
}

/** Validates the protected workflow boundary before importing database code. */
export function stagingSelectionReviewMode(
  env: StagingSelectionReviewEnvironment,
): StagingSelectionReviewMode {
  requiredExact(env.GITHUB_ACTIONS, "true", "github_actions");
  requiredExact(env.GITHUB_EVENT_NAME, "workflow_dispatch", "github_event");
  requiredExact(env.GITHUB_REPOSITORY, "elizaOS/eliza", "github_repository");
  requiredExact(env.GITHUB_REF, "refs/heads/develop", "github_ref");
  requiredExact(env.ELIZA_CLOUD_ENVIRONMENT, "staging", "cloud_environment");
  if (!env.DATABASE_URL) throw new Error("database_url_missing");
  if (
    !env.ELIZAOS_CLOUD_API_KEY ||
    env.ELIZAOS_CLOUD_API_KEY.trim() !== env.ELIZAOS_CLOUD_API_KEY ||
    /\s/.test(env.ELIZAOS_CLOUD_API_KEY)
  ) {
    throw new Error("cloud_api_key_invalid");
  }
  const mode = env.STAGING_SELECTION_REVIEW_MODE ?? "dry-run";
  if (mode !== "dry-run" && mode !== "apply") {
    throw new Error("selection_review_mode_invalid");
  }
  if (
    mode === "apply" &&
    env.STAGING_SELECTION_REVIEW_CONFIRMATION !==
      STAGING_SELECTION_REVIEW_CONFIRMATION
  ) {
    throw new Error("selection_review_confirmation_invalid");
  }
  return mode;
}

/** Converts private review facts to the only operator-visible output shape. */
export function stagingSelectionReviewReport(
  mode: StagingSelectionReviewMode,
  review: PersonalDedicatedSelectionReviewPreview,
): StagingSelectionReviewReport {
  return {
    schemaVersion: 1,
    environment: "staging",
    mode,
    outcome: mode === "apply" ? "refreshed" : "reviewed",
    receiptState: review.receiptCurrent ? "current" : "stale",
    retainedStatus: review.retainedStatus,
    stateDisposition: review.stateDisposition,
    candidateCount: review.candidateCount,
    invariants: {
      existingSelectionRequired: true,
      serverOwnedTargetRetained: true,
      startsCompute: review.startsCompute,
      createsJob: review.createsJob,
      deletesRows: review.deletesRows,
      changesCutover: review.changesCutover,
      changesBillingOrCredits: false,
    },
  };
}

function privacySafeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unclassified_failure";
  const code = Reflect.get(error, "code");
  if (
    typeof code === "string" &&
    /^PERSONAL_DEDICATED_SELECTION_[A-Z_]+$/.test(code)
  ) {
    return code.toLowerCase();
  }
  const message = Reflect.get(error, "message");
  if (typeof message === "string" && /^[a-z_]+$/.test(message)) return message;
  return "unclassified_failure";
}

export async function runStagingSelectionReview(
  env: StagingSelectionReviewEnvironment = process.env,
): Promise<StagingSelectionReviewReport> {
  const mode = stagingSelectionReviewMode(env);
  const [apiKeyRepositoryModule, selectionModule, sharedAgentModule] =
    await Promise.all([
      import("../../shared/src/db/repositories/api-keys"),
      import(
        "../../shared/src/lib/services/personal-dedicated-adoption-selection"
      ),
      import(
        "../../shared/src/lib/services/shared-runtime/personal-shared-agent"
      ),
    ]);
  const cloudApiKey = env.ELIZAOS_CLOUD_API_KEY;
  if (!cloudApiKey) throw new Error("cloud_api_key_invalid");
  const keyHash = createHash("sha256").update(cloudApiKey).digest("hex");
  const owner =
    await apiKeyRepositoryModule.apiKeysRepository.findActiveByHashConsistent(
      keyHash,
    );
  if (!owner) throw new Error("cloud_api_key_owner_unavailable");
  const common = {
    organizationId: owner.organization_id,
    userId: owner.user_id,
    sourceAgentId: sharedAgentModule.personalSharedAgentId({
      organizationId: owner.organization_id,
      userId: owner.user_id,
    }),
  };
  const preview =
    await selectionModule.previewPersonalDedicatedSelectionReview(common);
  const review =
    mode === "dry-run"
      ? preview
      : await selectionModule.executePersonalDedicatedSelectionReview({
          ...common,
          expectedReceiptInventoryFingerprint:
            preview.receiptInventoryFingerprint,
          expectedReceiptUpdatedAt: preview.receiptUpdatedAt,
          expectedCurrentInventoryFingerprint:
            preview.currentInventoryFingerprint,
          expectedCurrentStateDisposition: preview.stateDisposition,
          expectedCurrentCandidateCount: preview.candidateCount,
        });
  return stagingSelectionReviewReport(mode, review);
}

if (import.meta.main) {
  try {
    process.stdout.write(
      `${JSON.stringify(await runStagingSelectionReview(), null, 2)}\n`,
    );
  } catch (error) {
    // error-policy:J1 the CLI boundary emits only an allowlisted code because
    // database and credential values must never reach the Actions log.
    process.stderr.write(
      `Staging Dedicated selection review failed: ${privacySafeErrorCode(error)}\n`,
    );
    process.exitCode = 1;
  }
}
