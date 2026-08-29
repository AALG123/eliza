/**
 * Produces redacted PostgreSQL identity receipts for preparation and for the
 * migration runner's same-session enforcement boundary. The standalone entry
 * is read-only; authoritative release enforcement happens inside the migrator.
 */

import { appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  type DatabaseIdentityReceipt,
  type IdentityQueryClient,
  readDatabaseIdentityReceipt,
} from "./database-identity-receipt";

export type {
  DatabaseIdentityReceipt,
  IdentityQueryClient,
} from "./database-identity-receipt";
export { readDatabaseIdentityReceipt } from "./database-identity-receipt";

interface ClientConfig {
  application_name?: string;
  connectionString: string;
  connectionTimeoutMillis?: number;
  query_timeout?: number;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  statement_timeout?: number;
}

export interface RuntimePgClient extends IdentityQueryClient {
  connect(): Promise<void>;
  end(): Promise<void>;
}

export interface DatabaseIdentityReporterDependencies {
  createClient?: (databaseUrl: string) => Promise<RuntimePgClient>;
  publishResult?: typeof publishDatabaseIdentityResult;
  writeStdout?: (message: string) => void;
}

const { Client } = createRequire(import.meta.url)("pg") as {
  Client: new (config: ClientConfig) => RuntimePgClient;
};
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type DatabaseIdentityGateMode = "off" | "report" | "enforce";

export interface DatabaseIdentityConfig {
  environment: "staging" | "production";
  expectedAuthoritySha256?: string;
  expectedClusterSha256?: string;
  ignoredExpectedDigests?: Array<"cluster" | "authority">;
  mode: DatabaseIdentityGateMode;
}

export interface IdentityPreflightResult {
  mismatches: Array<"cluster" | "authority">;
  receipt?: DatabaseIdentityReceipt;
  status: "disabled" | "match" | "mismatch" | "reported" | "unavailable";
}

function readMode(value: string | undefined): DatabaseIdentityGateMode {
  const normalized = (value ?? "off").trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "report" ||
    normalized === "enforce"
  ) {
    return normalized;
  }
  throw new Error(
    "DATABASE_IDENTITY_GATE_MODE must be off, report, or enforce",
  );
}

function readOptionalDigest(
  value: string | undefined,
  name: string,
  strict: boolean,
): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!SHA256_PATTERN.test(normalized)) {
    if (!strict) return undefined;
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

/** Reads the nonsecret identity authority and its explicit activation mode. */
export function readDatabaseIdentityConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseIdentityConfig {
  const mode = readMode(environment.DATABASE_IDENTITY_GATE_MODE);
  const target =
    environment.DATABASE_IDENTITY_ENVIRONMENT?.trim().toLowerCase();
  if (target !== "staging" && target !== "production") {
    throw new Error(
      "DATABASE_IDENTITY_ENVIRONMENT must be staging or production",
    );
  }
  const config: DatabaseIdentityConfig = {
    environment: target,
    expectedAuthoritySha256: undefined,
    expectedClusterSha256: undefined,
    mode,
  };
  // Off mode must remain inert even while operators prepare or rotate the
  // protected expected receipts.
  if (mode === "off") return config;

  const strict = mode === "enforce";
  config.expectedClusterSha256 = readOptionalDigest(
    environment.DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256,
    "DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256",
    strict,
  );
  config.expectedAuthoritySha256 = readOptionalDigest(
    environment.DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256,
    "DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256",
    strict,
  );
  if (mode === "report") {
    const ignoredExpectedDigests: Array<"cluster" | "authority"> = [];
    if (
      environment.DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256?.trim() &&
      !config.expectedClusterSha256
    ) {
      ignoredExpectedDigests.push("cluster");
    }
    if (
      environment.DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256?.trim() &&
      !config.expectedAuthoritySha256
    ) {
      ignoredExpectedDigests.push("authority");
    }
    if (ignoredExpectedDigests.length > 0) {
      config.ignoredExpectedDigests = ignoredExpectedDigests;
    }
  }
  if (
    mode === "enforce" &&
    (!config.expectedClusterSha256 || !config.expectedAuthoritySha256)
  ) {
    throw new Error(
      "enforce mode requires both expected database identity SHA-256 digests",
    );
  }
  return config;
}

/** Evaluates the receipt without exposing the underlying server, role, or database names. */
export async function runDatabaseIdentityPreflight(
  config: DatabaseIdentityConfig,
  client?: IdentityQueryClient,
): Promise<IdentityPreflightResult> {
  if (config.mode === "off") return { status: "disabled", mismatches: [] };
  if (!client)
    throw new Error(
      "database identity client is required when the gate is active",
    );
  let receipt: DatabaseIdentityReceipt;
  try {
    receipt = await readDatabaseIdentityReceipt(client, config.environment);
  } catch (error) {
    if (config.mode === "report") {
      return { status: "unavailable", mismatches: [] };
    }
    throw error;
  }
  const mismatches: Array<"cluster" | "authority"> = [];
  if (
    config.expectedClusterSha256 &&
    receipt.clusterSha256 !== config.expectedClusterSha256
  ) {
    mismatches.push("cluster");
  }
  if (
    config.expectedAuthoritySha256 &&
    receipt.authoritySha256 !== config.expectedAuthoritySha256
  ) {
    mismatches.push("authority");
  }
  if (config.mode === "enforce" && mismatches.length > 0) {
    throw new Error(`database identity mismatch: ${mismatches.join(",")}`);
  }
  const hasCompleteExpectedIdentity = Boolean(
    config.expectedClusterSha256 && config.expectedAuthoritySha256,
  );
  return {
    status:
      mismatches.length > 0
        ? "mismatch"
        : hasCompleteExpectedIdentity
          ? "match"
          : "reported",
    mismatches,
    receipt,
  };
}

async function clientConfig(databaseUrl: string): Promise<ClientConfig> {
  // Keep the heavy Cloud database module outside the pure receipt/test path.
  const { enforceTlsForRemote } = await import(
    "@elizaos/cloud-shared/db/client"
  );
  const { url, ssl } = enforceTlsForRemote(databaseUrl);
  return {
    connectionString: url,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 5_000,
    application_name: "eliza-database-identity-preflight",
    ...(ssl ? { ssl } : {}),
  };
}

async function createRuntimePgClient(
  databaseUrl: string,
): Promise<RuntimePgClient> {
  return new Client(await clientConfig(databaseUrl));
}

/** Formats a redacted receipt for operator logs and GitHub step summaries. */
function formatDatabaseIdentitySummary(
  result: IdentityPreflightResult,
): string {
  const lines = [
    "### PostgreSQL identity preflight",
    "",
    `- Status: \`${result.status}\``,
  ];
  if (result.receipt) {
    lines.push(
      `- Environment: \`${result.receipt.environment}\``,
      `- PostgreSQL major: \`${result.receipt.postgresMajor}\``,
      `- Cluster receipt: \`${result.receipt.clusterSha256}\``,
      `- Authority receipt: \`${result.receipt.authoritySha256}\``,
    );
  }
  if (result.mismatches.length > 0) {
    lines.push(`- Mismatch classes: \`${result.mismatches.join(",")}\``);
  }
  return `${lines.join("\n")}\n`;
}

/** Publishes only redacted identity results and generic diagnostic classes. */
export async function publishDatabaseIdentityResult(
  config: DatabaseIdentityConfig,
  result: IdentityPreflightResult,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const output = formatDatabaseIdentitySummary(result);
  process.stdout.write(output);
  if (environment.GITHUB_STEP_SUMMARY) {
    await appendFile(environment.GITHUB_STEP_SUMMARY, output, "utf8");
  }
  if (result.status === "mismatch" && config.mode === "report") {
    process.stdout.write(
      "::warning::database identity report differs from the protected authority\n",
    );
  }
  if (result.status === "unavailable") {
    process.stdout.write(
      "::warning::database identity report unavailable; inspect protected operator logs\n",
    );
  }
  if (config.ignoredExpectedDigests?.length) {
    process.stdout.write(
      "::warning::database identity report ignored malformed protected expected digest(s)\n",
    );
  }
}

/** Runs the standalone reporter and returns its process exit status. */
export async function runDatabaseIdentityReporter(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: DatabaseIdentityReporterDependencies = {},
): Promise<number> {
  const createClient = dependencies.createClient ?? createRuntimePgClient;
  const publishResult =
    dependencies.publishResult ?? publishDatabaseIdentityResult;
  const writeStdout =
    dependencies.writeStdout ??
    ((message: string) => process.stdout.write(message));
  const config = readDatabaseIdentityConfig(environment);
  if (config.mode === "off") {
    writeStdout(
      "[database-identity] gate disabled; no database query performed\n",
    );
    return 0;
  }
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    if (config.mode === "report") {
      writeStdout(
        "::warning::database identity report unavailable: DATABASE_URL is missing\n",
      );
      return 1;
    }
    throw new Error(
      "DATABASE_URL is required when database identity enforcement is active",
    );
  }
  let client: RuntimePgClient | undefined;
  try {
    client = await createClient(databaseUrl);
    await client.connect();
    const result = await runDatabaseIdentityPreflight(config, client);
    await publishResult(config, result, environment);
    return result.status === "unavailable" ? 1 : 0;
  } catch (error) {
    // error-policy:J1 the CLI boundary emits only a generic class so provider
    // errors cannot leak connection strings, hosts, roles, or database names.
    if (config.mode === "report") {
      writeStdout(
        "::warning::database identity report unavailable; inspect protected operator logs\n",
      );
      return 1;
    }
    throw error;
  } finally {
    await client?.end().catch(() => {
      // error-policy:J6 teardown failure cannot replace the primary gate result.
      process.stderr.write(
        "[database-identity] warning: database client close failed\n",
      );
    });
  }
}

if (import.meta.main) {
  runDatabaseIdentityReporter().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      process.stderr.write(
        "[database-identity] fatal: identity enforcement failed\n",
      );
      process.exitCode = 1;
    },
  );
}
