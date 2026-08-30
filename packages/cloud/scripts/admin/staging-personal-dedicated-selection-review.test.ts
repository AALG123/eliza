/**
 * Locks the staging-only invocation boundary, explicit apply consent, and
 * privacy-safe output contract for Dedicated selection receipt re-review.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import {
  STAGING_SELECTION_REVIEW_CONFIRMATION,
  stagingSelectionReviewMode,
  stagingSelectionReviewReport,
} from "./staging-personal-dedicated-selection-review";

const baseEnvironment = {
  DATABASE_URL: "postgresql://private.invalid/staging",
  ELIZAOS_CLOUD_API_KEY: "eliza_private_value",
  ELIZA_CLOUD_ENVIRONMENT: "staging",
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/develop",
  GITHUB_REPOSITORY: "elizaOS/eliza",
};

interface WorkflowStep {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string | number | boolean>;
}

interface ReviewWorkflow {
  jobs: {
    review: {
      concurrency: { "cancel-in-progress": boolean; group: string };
      environment: string;
      env: Record<string, string>;
      permissions?: Record<string, string>;
      steps: WorkflowStep[];
      "timeout-minutes": number;
    };
  };
  on: {
    workflow_dispatch: {
      inputs: {
        confirmation: { default: string; required: boolean; type: string };
        expected_develop_commit: { required: boolean; type: string };
        mode: {
          default: string;
          options: string[];
          required: boolean;
          type: string;
        };
      };
    };
  };
  permissions: Record<string, string>;
}

function githubExpression(body: string): string {
  return ["$", "{{ ", body, " }}"].join("");
}

describe("staging personal Dedicated selection review", () => {
  test("defaults to dry-run and requires exact protected apply consent", () => {
    expect(stagingSelectionReviewMode(baseEnvironment)).toBe("dry-run");
    expect(
      stagingSelectionReviewMode({
        ...baseEnvironment,
        STAGING_SELECTION_REVIEW_MODE: "apply",
        STAGING_SELECTION_REVIEW_CONFIRMATION:
          STAGING_SELECTION_REVIEW_CONFIRMATION,
      }),
    ).toBe("apply");
    expect(() =>
      stagingSelectionReviewMode({
        ...baseEnvironment,
        STAGING_SELECTION_REVIEW_MODE: "apply",
      }),
    ).toThrow("selection_review_confirmation_invalid");
    for (const environment of [
      { ...baseEnvironment, GITHUB_ACTIONS: "false" },
      { ...baseEnvironment, GITHUB_REF: "refs/heads/main" },
      { ...baseEnvironment, GITHUB_EVENT_NAME: "push" },
      { ...baseEnvironment, ELIZA_CLOUD_ENVIRONMENT: "production" },
      { ...baseEnvironment, ELIZAOS_CLOUD_API_KEY: " eliza_private_value" },
    ]) {
      expect(() => stagingSelectionReviewMode(environment)).toThrow();
    }
  });

  test("emits only allowlisted lifecycle facts and explicit no-side-effect invariants", () => {
    const report = stagingSelectionReviewReport("dry-run", {
      currentInventoryFingerprint: "a".repeat(64),
      receiptInventoryFingerprint: "b".repeat(64),
      receiptUpdatedAt: "2026-08-30T12:00:00.000Z",
      retainedStatus: "running",
      retainedLifecycleRevision: 5749,
      stateDisposition: "fresh_boot_no_verified_backup",
      candidateCount: 2,
      receiptCurrent: false,
      startsCompute: false,
      createsJob: false,
      deletesRows: false,
      changesCutover: false,
    });
    expect(report).toEqual({
      schemaVersion: 1,
      environment: "staging",
      mode: "dry-run",
      outcome: "reviewed",
      receiptState: "stale",
      retainedStatus: "running",
      stateDisposition: "fresh_boot_no_verified_backup",
      candidateCount: 2,
      invariants: {
        existingSelectionRequired: true,
        serverOwnedTargetRetained: true,
        startsCompute: false,
        createsJob: false,
        deletesRows: false,
        changesCutover: false,
        changesBillingOrCredits: false,
      },
    });
    const output = JSON.stringify(report);
    expect(output).not.toContain("private.invalid");
    expect(output).not.toContain("eliza_private_value");
    expect(output).not.toContain("a".repeat(64));
    expect(output).not.toContain("b".repeat(64));
    expect(output).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
  });

  test("workflow is manual, staging-protected, exact-head, and non-concurrent", () => {
    const workflowPath = resolve(
      import.meta.dirname,
      "../../../../.github/workflows/staging-personal-dedicated-selection-review.yml",
    );
    const workflow = parse(
      readFileSync(workflowPath, "utf8"),
    ) as ReviewWorkflow;
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on.workflow_dispatch.inputs.mode).toMatchObject({
      required: true,
      default: "dry-run",
      type: "choice",
      options: ["dry-run", "apply"],
    });
    expect(workflow.on.workflow_dispatch.inputs.confirmation).toMatchObject({
      required: false,
      default: "",
      type: "string",
    });
    const job = workflow.jobs.review;
    expect(job.environment).toBe("staging");
    expect(job["timeout-minutes"]).toBe(15);
    expect(job.concurrency).toEqual({
      group: "staging-personal-dedicated-selection-review",
      "cancel-in-progress": false,
    });
    expect(job.env.DATABASE_URL).toBe(githubExpression("secrets.DATABASE_URL"));
    expect(job.env.ELIZAOS_CLOUD_API_KEY).toBe(
      githubExpression(
        "secrets.ELIZAOS_CLOUD_API_KEY || secrets.ELIZACLOUD_API_KEY",
      ),
    );
    const guard = job.steps.find(
      (step) =>
        step.name === "Require exact develop commit and explicit apply intent",
    );
    expect(guard?.run).toContain("refs/heads/develop");
    expect(guard?.run).toContain(STAGING_SELECTION_REVIEW_CONFIRMATION);
    const execution = job.steps.find(
      (step) => step.name === "Review existing staging selection receipt",
    );
    expect(execution?.run).toBe(
      "bun run packages/cloud/scripts/admin/staging-personal-dedicated-selection-review.ts",
    );
  });
});
