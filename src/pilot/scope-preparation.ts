import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigError } from "../config/schema.js";
import { loadConfigSnapshot } from "../config/load.js";
import {
  hashRegularFileNoFollow,
  type PrivateFileIdentity,
  privateFileIdentityMatches,
  readBoundedRegularFile,
  SecureFileError,
  writeNewPrivateFileNoFollow,
} from "../security/file.js";
import { validateMaestroFlowSafety, validatePilotFlowReadiness } from "../security/flow.js";
import { managedWalletExpectedSha256 } from "../security/wallet-artifact.js";
import type { ResolvedLaunchRigConfig } from "../types.js";
import {
  loadPilotSessionScope,
  pilotSessionFlowReviewSha256,
  PilotSessionScopeError,
  type PilotSessionScopeFlow,
  type PilotSessionScopeV1,
} from "./session-scope.js";
import { sha256Value } from "./store.js";

const MAX_APK_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FLOW_BYTES = 512 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SCOPE_SCENARIO_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CORE_MWA_KINDS = ["mwa-authorize", "mwa-siws", "mwa-sign-message", "mwa-reject"] as const;
const GENERATED_FLOW_TEMPLATES = new Set(CORE_MWA_KINDS.map((kind) => kind + ".example.yaml"));
const DELETION_METHODS = [
  "standard-delete",
  "secure-delete",
  "publisher-managed",
  "other-documented",
] as const;
const ACCEPTED_BUNDLE_PROFILES = new Set([
  "phase-2g-operational-contract-rc-v10",
  "phase-2h-consent-safe-scope-rc-v11",
  "phase-2i-recruitment-register-rc-v12",
  "phase-2l-human-prospect-review-rc-v13",
  "phase-2m-send-decision-preparation-rc-v14",
  "phase-2n-human-send-decision-rc-v15",
  "phase-3-config-diagnostics-rc-v16",
  "phase-3-runtime-rule-fixtures-rc-v17",
]);

const DRAFT_LIMITATIONS = [
  "This draft requires human review and a separate launchrig pilot scope receipt before any attended device check.",
  "Local bundle and input integrity checks do not establish source authenticity, publisher identity, operator authority, consent, or a device environment.",
  "No pilot state, ADB, Maestro, connected device, wallet action, flow execution, external adoption, Seeker hardware, Seed Vault behavior, confirmed defect, or grant readiness was established.",
] as const;

type CoreMwaKind = (typeof CORE_MWA_KINDS)[number];
export type PilotScopeDeletionMethod = (typeof DELETION_METHODS)[number];

interface PublisherBundleSnapshot {
  profile: string;
  bundleId: string;
  manifestSha256: string;
  sha256SumsSha256: string;
  packageSha256: string;
}

type PublisherBundleSnapshotVerifier = (
  directory: string,
) => Promise<PublisherBundleSnapshot>;

export interface PilotScopePreparationDependencies {
  verifyPublisherBundleSnapshot?: PublisherBundleSnapshotVerifier;
}

export interface PreparePilotSessionScopeOptions {
  configPath: string;
  bundleDirectory: string;
  expiresOn: string;
  deletionMethod: string;
  outputPath: string;
}

export interface PilotSessionScopeDraftResultV1 {
  schemaVersion: 1;
  kind: "launchrig-pilot-session-scope-draft-result";
  profile: "external-mwa-pilot-scope-v1";
  status: "created";
  scopeFileSha256: string;
  binding: {
    bundleId: string;
    packageSha256: string;
    appBuildSha256: string;
    walletArtifactSha256: string;
    flowReviewSha256: string;
    scopeSha256: string;
  };
  bundleVerification: {
    status: "passed";
    manifestSha256: string;
    sha256SumsSha256: string;
  };
  policyValid: true;
  reviewRequired: true;
  approvalReceiptCreated: false;
  pilotStateChecked: false;
  deviceEnvironmentChecked: false;
  publisherIdentity: "not-established";
  consentAuthenticity: "not-established";
  bundleAuthenticity: "not-established";
  externalGrantGate: "not-established";
  grantReady: false;
  limitations: string[];
}

interface ScopeInputSnapshot {
  config: ResolvedLaunchRigConfig;
  configSha256: string;
  appBuildSha256: string;
  walletArtifactSha256: string;
  flows: PilotSessionScopeFlow[];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: string, label: string): string {
  if (value.trim().length === 0 || value.includes("\0")) {
    throw new PilotSessionScopeError(label + " is required");
  }
  return value;
}

function strictDate(value: string, today: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PilotSessionScopeError("Pilot scope retention expiry is invalid");
  }
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new PilotSessionScopeError("Pilot scope retention expiry is invalid");
  }
  if (value < today) throw new PilotSessionScopeError("Pilot scope retention expiry is in the past");
  return value;
}

function deletionMethod(value: string): PilotScopeDeletionMethod {
  if (!(DELETION_METHODS as readonly string[]).includes(value)) {
    throw new PilotSessionScopeError(
      "Pilot scope deletion method must be standard-delete, secure-delete, publisher-managed, or other-documented",
    );
  }
  return value as PilotScopeDeletionMethod;
}

function assertProjectPolicy(config: ResolvedLaunchRigConfig): void {
  if (
    config.project.packageName.startsWith("dev.launchrig.") ||
    config.project.packageName === "com.solana.mobilewalletadapter.fakedapp"
  ) {
    throw new PilotSessionScopeError("Controlled LaunchRig fixtures cannot be prepared as external pilot scope");
  }
  if (
    config.project.packageName === "com.example.app" ||
    config.project.name === "My Solana Mobile App"
  ) {
    throw new PilotSessionScopeError("Replace the generated project identity before preparing a pilot scope");
  }
  if (!config.resolvedApk) {
    throw new PilotSessionScopeError("Pilot scope preparation requires a configured app APK");
  }
  if (config.wallet.mode === "real") {
    throw new PilotSessionScopeError("Pilot scope preparation supports only allowlisted development wallets");
  }
  if (!config.device.requirePhysical) {
    throw new PilotSessionScopeError("Pilot scope preparation requires a physical Android device policy");
  }
  if (
    config.scenarios.length !== CORE_MWA_KINDS.length ||
    config.scenarios.some((scenario) => !scenario.required) ||
    CORE_MWA_KINDS.some(
      (kind) => config.scenarios.filter((scenario) => scenario.kind === kind).length !== 1,
    )
  ) {
    throw new PilotSessionScopeError("Pilot scope preparation requires exactly four required core MWA scenarios");
  }
}

async function readFlow(
  config: ResolvedLaunchRigConfig,
  kind: CoreMwaKind,
): Promise<PilotSessionScopeFlow> {
  const scenario = config.scenarios.find((entry) => entry.kind === kind);
  if (!scenario) {
    throw new PilotSessionScopeError("Pilot scope preparation is missing a required core MWA flow");
  }
  if (!SCOPE_SCENARIO_ID.test(scenario.id)) {
    throw new PilotSessionScopeError("Pilot scope scenario ID is not compatible with the private scope contract");
  }
  if (GENERATED_FLOW_TEMPLATES.has(path.basename(scenario.flow).toLowerCase())) {
    throw new PilotSessionScopeError("Pilot scope flows must use publisher-owned promoted filenames");
  }
  let bytes: Buffer;
  let source: string;
  try {
    bytes = await readBoundedRegularFile(scenario.resolvedFlow, MAX_FLOW_BYTES);
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PilotSessionScopeError("Pilot scope flow cannot be read safely", 3);
  }
  const issues = [
    ...validateMaestroFlowSafety(source, config.project.packageName),
    ...validatePilotFlowReadiness(source),
  ];
  if (issues.length > 0) {
    throw new PilotSessionScopeError("Pilot scope flow is not ready: " + [...new Set(issues)].join("; "));
  }
  return { kind, scenarioId: scenario.id, fileSha256: sha256(bytes) };
}

async function captureScopeInputs(configPath: string): Promise<ScopeInputSnapshot> {
  let snapshot;
  try {
    snapshot = await loadConfigSnapshot(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      const unreadable = error.issues.some((issue) => issue.startsWith("Cannot read "));
      throw new PilotSessionScopeError(
        "Pilot scope configuration cannot be read or validated safely",
        unreadable ? 3 : 2,
      );
    }
    throw error;
  }
  const config = snapshot.config;
  assertProjectPolicy(config);

  let appBuildSha256: string;
  try {
    appBuildSha256 = (await hashRegularFileNoFollow(config.resolvedApk!, MAX_APK_BYTES)).sha256;
  } catch {
    throw new PilotSessionScopeError("Configured app APK cannot be hashed safely", 3);
  }

  const expectedWalletSha256 = config.wallet.packageName
    ? managedWalletExpectedSha256(config.wallet.packageName)
    : undefined;
  if (!expectedWalletSha256) {
    throw new PilotSessionScopeError("Pilot scope development-wallet artifact digest is unavailable");
  }
  let walletArtifactSha256: string;
  if (config.resolvedWalletApk) {
    try {
      walletArtifactSha256 = (
        await hashRegularFileNoFollow(config.resolvedWalletApk, MAX_APK_BYTES)
      ).sha256;
    } catch {
      throw new PilotSessionScopeError("Configured development-wallet APK cannot be hashed safely", 3);
    }
    if (walletArtifactSha256 !== expectedWalletSha256) {
      throw new PilotSessionScopeError(
        "Configured development-wallet APK does not match the managed artifact digest",
      );
    }
  } else {
    walletArtifactSha256 = expectedWalletSha256;
  }

  const flows = await Promise.all(CORE_MWA_KINDS.map((kind) => readFlow(config, kind)));
  if (
    new Set(config.scenarios.map((scenario) => scenario.resolvedFlow)).size !== CORE_MWA_KINDS.length ||
    new Set(flows.map((flow) => flow.scenarioId)).size !== CORE_MWA_KINDS.length ||
    new Set(flows.map((flow) => flow.fileSha256)).size !== CORE_MWA_KINDS.length
  ) {
    throw new PilotSessionScopeError(
      "Pilot scope core MWA scenarios must use distinct IDs, files, and flow definitions",
    );
  }
  return {
    config,
    configSha256: snapshot.sourceSha256,
    appBuildSha256,
    walletArtifactSha256,
    flows,
  };
}

function scopeInputIdentity(value: ScopeInputSnapshot): string {
  return JSON.stringify({
    configSha256: value.configSha256,
    appBuildSha256: value.appBuildSha256,
    walletArtifactSha256: value.walletArtifactSha256,
    flows: value.flows,
  });
}

function parseBundleSnapshot(value: unknown): PublisherBundleSnapshot {
  if (!isRecord(value)) throw new PilotSessionScopeError("Publisher bundle verification result is invalid", 3);
  const profile = value.profile;
  const bundleId = value.bundleId;
  const manifestSha256 = value.manifestSha256;
  const sha256SumsSha256 = value.sha256SumsSha256;
  const packageSha256 = value.packageSha256;
  if (typeof profile !== "string" || !ACCEPTED_BUNDLE_PROFILES.has(profile)) {
    throw new PilotSessionScopeError("Publisher bundle profile is not accepted for scope preparation");
  }
  if (typeof bundleId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(bundleId)) {
    throw new PilotSessionScopeError("Publisher bundle identity is invalid", 3);
  }
  if (
    typeof manifestSha256 !== "string" ||
    !SHA256.test(manifestSha256) ||
    typeof sha256SumsSha256 !== "string" ||
    !SHA256.test(sha256SumsSha256) ||
    typeof packageSha256 !== "string" ||
    !SHA256.test(packageSha256)
  ) {
    throw new PilotSessionScopeError("Publisher bundle digest projection is invalid", 3);
  }
  return { profile, bundleId, manifestSha256, sha256SumsSha256, packageSha256 };
}

async function defaultVerifyBundleSnapshot(directory: string): Promise<PublisherBundleSnapshot> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDirectory, "../../..");
  const verifierPath = path.join(packageRoot, "scripts", "verify-pilot-bundle.mjs");
  try {
    const loaded = (await import(pathToFileURL(verifierPath).href)) as Record<string, unknown>;
    if (typeof loaded.verifyPublisherBundleSnapshot !== "function") throw new Error("missing verifier");
    const verify = loaded.verifyPublisherBundleSnapshot as PublisherBundleSnapshotVerifier;
    return parseBundleSnapshot(await verify(directory));
  } catch (error) {
    if (error instanceof PilotSessionScopeError) throw error;
    throw new PilotSessionScopeError("Publisher bundle cannot be verified safely", 3);
  }
}

async function verifiedBundleSnapshot(
  directory: string,
  verify: PublisherBundleSnapshotVerifier,
): Promise<PublisherBundleSnapshot> {
  try {
    return parseBundleSnapshot(await verify(directory));
  } catch (error) {
    if (error instanceof PilotSessionScopeError) throw error;
    throw new PilotSessionScopeError("Publisher bundle cannot be verified safely", 3);
  }
}

function typedRef(type: "scope" | "operator" | "pilot" | "device", uuid: string): string {
  if (!UUID_V4.test(uuid)) throw new PilotSessionScopeError("Secure pilot scope references cannot be generated", 3);
  return "urn:launchrig:" + type + ":" + uuid;
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertOutputOutsideBundle(bundleDirectory: string, outputPath: string): Promise<void> {
  try {
    const [bundleRoot, outputParent] = await Promise.all([
      realpath(path.resolve(bundleDirectory)),
      realpath(path.dirname(path.resolve(outputPath))),
    ]);
    if (isContained(bundleRoot, path.join(outputParent, path.basename(outputPath)))) {
      throw new PilotSessionScopeError("Private scope output must be outside the publisher bundle");
    }
  } catch (error) {
    if (error instanceof PilotSessionScopeError) throw error;
    throw new PilotSessionScopeError("Private scope output destination cannot be resolved safely", 3);
  }
}

export async function preparePilotSessionScope(
  options: PreparePilotSessionScopeOptions,
  dependencies: PilotScopePreparationDependencies = {},
): Promise<PilotSessionScopeDraftResultV1> {
  const configPath = safeString(options.configPath, "Pilot scope configuration");
  const bundleDirectory = safeString(options.bundleDirectory, "Publisher bundle directory");
  const outputPath = safeString(options.outputPath, "Private scope output");
  if (!path.isAbsolute(outputPath)) {
    throw new PilotSessionScopeError("Private scope output path must be absolute");
  }
  const now = new Date();
  if (!Number.isFinite(now.valueOf())) throw new PilotSessionScopeError("Current date is invalid", 3);
  const expiresOn = strictDate(options.expiresOn, now.toISOString().slice(0, 10));
  const retentionDeletionMethod = deletionMethod(options.deletionMethod);
  const verify = dependencies.verifyPublisherBundleSnapshot ?? defaultVerifyBundleSnapshot;

  const firstBundle = await verifiedBundleSnapshot(bundleDirectory, verify);
  const firstInputs = await captureScopeInputs(configPath);
  await assertOutputOutsideBundle(bundleDirectory, outputPath);

  const uuid = randomUUID;
  const generatedUuids = [uuid(), uuid(), uuid(), uuid()];
  if (new Set(generatedUuids).size !== generatedUuids.length) {
    throw new PilotSessionScopeError("Secure pilot scope references cannot be generated", 3);
  }
  const scope: PilotSessionScopeV1 = {
    schemaVersion: 1,
    kind: "launchrig-pilot-session-scope",
    profile: "external-mwa-pilot-scope-v1",
    scopeRef: typedRef("scope", generatedUuids[0]!),
    operatorRef: typedRef("operator", generatedUuids[1]!),
    pilotRef: typedRef("pilot", generatedUuids[2]!),
    deviceRef: typedRef("device", generatedUuids[3]!),
    bundle: {
      bundleId: firstBundle.bundleId,
      manifestSha256: firstBundle.manifestSha256,
      sha256SumsSha256: firstBundle.sha256SumsSha256,
      packageSha256: firstBundle.packageSha256,
    },
    inputs: {
      configSha256: firstInputs.configSha256,
      appBuildSha256: firstInputs.appBuildSha256,
      walletArtifactSha256: firstInputs.walletArtifactSha256,
      flows: firstInputs.flows,
    },
    policy: {
      network: firstInputs.config.target.network,
      walletMode: firstInputs.config.wallet.mode as "mock-mwa" | "reference-fakewallet",
      physicalAndroidRequired: true,
      attendedExecutionRequired: true,
      manualWalletActionsRequired: true,
      valuableAssetsAllowed: false,
      capture: {
        screenshots: firstInputs.config.artifacts.screenshots,
        includeLogcat: firstInputs.config.privacy.includeLogcat,
        logcatLines: firstInputs.config.privacy.logcatLines,
      },
      retention: {
        maxRuns: firstInputs.config.artifacts.retention,
        expiresOn,
        deletionMethod: retentionDeletionMethod,
      },
      sharing: {
        publicEvidenceJson: false,
        sanitizedReports: false,
        publisherName: false,
        publisherLogo: false,
        approvedQuote: false,
        confirmedDefectRecord: false,
      },
    },
  };

  const [secondInputs, secondBundle] = await Promise.all([
    captureScopeInputs(configPath),
    verifiedBundleSnapshot(bundleDirectory, verify),
  ]);
  if (
    scopeInputIdentity(firstInputs) !== scopeInputIdentity(secondInputs) ||
    JSON.stringify(firstBundle) !== JSON.stringify(secondBundle)
  ) {
    throw new PilotSessionScopeError("Pilot scope inputs changed while the draft was being prepared", 3);
  }

  const source = Buffer.from(JSON.stringify(scope, null, 2) + "\n", "utf8");
  let writtenIdentity: PrivateFileIdentity;
  try {
    writtenIdentity = await writeNewPrivateFileNoFollow(outputPath, source);
  } catch (error) {
    if (error instanceof SecureFileError && error.reason === "exists") {
      throw new PilotSessionScopeError("Private scope output already exists");
    }
    throw new PilotSessionScopeError(
      "Private scope output cannot be written safely; a mode-600 output may remain and must be inspected or removed manually",
      3,
    );
  }

  let loaded;
  try {
    loaded = await loadPilotSessionScope(writtenIdentity.canonicalPath);
    const expectedBinding = {
      bundleId: scope.bundle.bundleId,
      packageSha256: scope.bundle.packageSha256,
      appBuildSha256: scope.inputs.appBuildSha256,
      walletArtifactSha256: scope.inputs.walletArtifactSha256,
      flowReviewSha256: pilotSessionFlowReviewSha256(scope.inputs.flows),
      scopeSha256: sha256Value(scope),
    };
    if (
      loaded.receipt.scopeFileSha256 !== sha256(source) ||
      JSON.stringify(loaded.receipt.binding) !== JSON.stringify(expectedBinding) ||
      loaded.receipt.bundleVerification.manifestSha256 !== scope.bundle.manifestSha256 ||
      loaded.receipt.bundleVerification.sha256SumsSha256 !== scope.bundle.sha256SumsSha256 ||
      !(await privateFileIdentityMatches(writtenIdentity))
    ) {
      throw new PilotSessionScopeError("Prepared private scope changed before final validation", 3);
    }
  } catch (error) {
    if (error instanceof PilotSessionScopeError) {
      throw new PilotSessionScopeError(
        "Prepared private scope failed its final validation; a mode-600 output may remain and must be inspected or removed manually",
        3,
      );
    }
    throw error;
  }

  return {
    schemaVersion: 1,
    kind: "launchrig-pilot-session-scope-draft-result",
    profile: "external-mwa-pilot-scope-v1",
    status: "created",
    scopeFileSha256: loaded.receipt.scopeFileSha256,
    binding: { ...loaded.receipt.binding },
    bundleVerification: {
      status: "passed",
      ...loaded.receipt.bundleVerification,
    },
    policyValid: true,
    reviewRequired: true,
    approvalReceiptCreated: false,
    pilotStateChecked: false,
    deviceEnvironmentChecked: false,
    publisherIdentity: "not-established",
    consentAuthenticity: "not-established",
    bundleAuthenticity: "not-established",
    externalGrantGate: "not-established",
    grantReady: false,
    limitations: [...DRAFT_LIMITATIONS],
  };
}
