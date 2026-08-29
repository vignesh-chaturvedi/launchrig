import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDocument, stringify } from "yaml";
import { loadConfig, validateConfigPaths } from "../config/load.js";
import { ConfigError } from "../config/schema.js";
import {
  assertPilotId,
  PilotError,
  pilotStatePath,
  readPilotState,
  readOnlyPilotStatePath,
  sha256Value,
  withPilotLock,
  writePilotState,
} from "../pilot/store.js";
import type {
  ExternalGrantGateStatus,
  PilotMetricsV1,
  PilotProjectRunner,
  PilotRunEvidenceV1,
  PilotStateCoreV1,
  PilotStateV1,
  PilotTechnicalGate,
  PublicPilotEvidenceV2,
  PublicPilotEvidenceV3,
} from "../pilot/types.js";
import {
  loadPilotSessionScope,
  pilotSessionFlowReviewSha256,
  type LoadedPilotSessionScopeV1,
  type PilotSessionScopeFlow,
} from "../pilot/session-scope.js";
import type { LaunchRigReport, ResolvedLaunchRigConfig } from "../types.js";
import type { RunOptions, RunOutput } from "../runner/orchestrator.js";
import {
  PILOT_PREFLIGHT_CHECK_IDS,
  RUN_CHECK_IDS,
  scenarioCheckId,
  type PilotPreflightCheckId,
} from "../rules/catalog.js";
import { isRegularFileNoFollow, readBoundedRegularFile } from "../security/file.js";
import { validateMaestroFlowSafety, validatePilotFlowReadiness } from "../security/flow.js";
import { redactJsonValue } from "../security/redact.js";
import { managedWalletExpectedSha256 } from "../security/wallet-artifact.js";
import { doctor, type DoctorOptions, type DoctorOutput } from "./doctor.js";
import { runProject } from "./run.js";

const SETUP_TARGET_MS = 30 * 60 * 1000;
const RUNTIME_TARGET_MS = 10 * 60 * 1000;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const CORE_MWA_KINDS = ["mwa-authorize", "mwa-siws", "mwa-sign-message", "mwa-reject"] as const;
const GENERATED_FLOW_TEMPLATES = new Set(CORE_MWA_KINDS.map((kind) => kind + ".example.yaml"));

type InputHashes = Awaited<ReturnType<typeof inputHashes>>;
type AttemptFailure = NonNullable<PilotRunEvidenceV1["failureKind"]>;

class PilotReportError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filePath);
    input.once("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("end", resolve);
  });
  return hash.digest("hex");
}

function sha256Bytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pilotProjectIssues(config: ResolvedLaunchRigConfig): string[] {
  const issues: string[] = [];
  if (
    config.project.packageName.startsWith("dev.launchrig.") ||
    config.project.packageName === "com.solana.mobilewalletadapter.fakedapp"
  ) {
    issues.push("Controlled LaunchRig fixtures cannot be recorded as external pilot evidence");
  }
  if (
    config.project.packageName === "com.example.app" ||
    config.project.name === "My Solana Mobile App"
  ) {
    issues.push("Replace the generated project name and application ID before a publisher pilot");
  }
  return issues;
}

function pilotWalletIssues(config: ResolvedLaunchRigConfig): string[] {
  if (config.wallet.mode === "real") {
    return ["Phase 2 pilot automation supports only allowlisted test wallets"];
  }
  return [];
}

function assertEligibleProject(config: ResolvedLaunchRigConfig): void {
  const issues = [
    ...pilotProjectIssues(config),
    ...pilotWalletIssues(config),
    ...(!config.device.requirePhysical ? ["Pilot evidence requires a physical Android device"] : []),
  ];
  if (!config.scenarios.some((scenario) => scenario.required)) {
    issues.push("Pilot evidence requires at least one required scenario");
  }
  if (issues.length > 0) throw new PilotError(issues.join("; "));
}

async function loadCheckedConfig(configPath: string): Promise<ResolvedLaunchRigConfig> {
  const config = await loadConfig(configPath);
  const issues = await validateConfigPaths(config);
  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}

async function loadEligibleConfig(configPath: string): Promise<ResolvedLaunchRigConfig> {
  const config = await loadCheckedConfig(configPath);
  assertEligibleProject(config);
  return config;
}

interface PilotFlowReview {
  promotionIssues: string[];
  coverageIssues: string[];
}

async function reviewPilotFlows(config: ResolvedLaunchRigConfig): Promise<PilotFlowReview> {
  const promotionIssues: string[] = [];
  const flowHashes = new Map<string, string>();
  for (const scenario of config.scenarios) {
    if (GENERATED_FLOW_TEMPLATES.has(path.basename(scenario.flow).toLowerCase())) {
      promotionIssues.push(
        "Scenario " +
          scenario.id +
          " uses the reserved init template " +
          path.basename(scenario.flow) +
          ". Copy it to a publisher-owned filename and update scenarios[].flow",
      );
    }
    let bytes: Buffer;
    let source: string;
    try {
      bytes = await readBoundedRegularFile(scenario.resolvedFlow, 512 * 1024);
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      promotionIssues.push("Scenario " + scenario.id + " flow cannot be read safely");
      continue;
    }
    flowHashes.set(scenario.id, sha256Bytes(bytes));
    for (const issue of validateMaestroFlowSafety(source, config.project.packageName)) {
      promotionIssues.push("Scenario " + scenario.id + " " + issue);
    }
    for (const issue of validatePilotFlowReadiness(source)) {
      promotionIssues.push("Scenario " + scenario.id + " " + issue);
    }
  }

  const coverageIssues: string[] = [];
  const missingKinds = CORE_MWA_KINDS.filter(
    (kind) => !config.scenarios.some((scenario) => scenario.kind === kind && scenario.required),
  );
  if (missingKinds.length > 0) {
    coverageIssues.push("Required MWA coverage is missing: " + missingKinds.join(", "));
  } else {
    const coreScenarios = CORE_MWA_KINDS.flatMap((kind) => {
      const scenario = config.scenarios.find((entry) => entry.kind === kind && entry.required);
      return scenario ? [scenario] : [];
    });
    if (new Set(coreScenarios.map((scenario) => scenario.resolvedFlow)).size !== CORE_MWA_KINDS.length) {
      coverageIssues.push("Required MWA coverage must use four distinct promoted flow files");
    } else if (coreScenarios.some((scenario) => !flowHashes.has(scenario.id))) {
      coverageIssues.push("Required MWA flow definitions could not be inspected safely");
    } else if (
      new Set(coreScenarios.map((scenario) => flowHashes.get(scenario.id))).size !== CORE_MWA_KINDS.length
    ) {
      coverageIssues.push("Required MWA coverage must use four distinct publisher flow definitions");
    }
  }
  return { promotionIssues, coverageIssues };
}

async function assertPilotFlowPolicy(config: ResolvedLaunchRigConfig): Promise<void> {
  const review = await reviewPilotFlows(config);
  if (review.promotionIssues.length > 0) {
    throw new PilotError("Pilot flows are not ready: " + review.promotionIssues.join("; "));
  }
  const hasAllCoreKinds = CORE_MWA_KINDS.every((kind) =>
    config.scenarios.some((scenario) => scenario.kind === kind && scenario.required),
  );
  if (!hasAllCoreKinds) return;
  if (review.coverageIssues.length > 0) {
    throw new PilotError("Pilot MWA coverage is not ready: " + review.coverageIssues.join("; "));
  }
}

async function loadPilotLintConfig(configPath: string): Promise<ResolvedLaunchRigConfig> {
  try {
    return await loadConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      const issues = error.issues.map((issue) =>
        issue.startsWith("Cannot read ") ? "Configuration file cannot be read safely" : issue,
      );
      throw new ConfigError(issues);
    }
    throw error;
  }
}

async function inputHashes(config: ResolvedLaunchRigConfig) {
  const flowEntries = await Promise.all(
    [...config.scenarios]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(async (scenario) => [
        scenario.id,
        sha256Bytes(await readBoundedRegularFile(scenario.resolvedFlow, 512 * 1024)),
      ] as const),
  );
  return {
    configSha256: await sha256File(config.configPath),
    flowSha256: Object.fromEntries(flowEntries) as Record<string, string>,
    ...(config.resolvedApk ? { appArtifactSha256: await sha256File(config.resolvedApk) } : {}),
    ...(config.resolvedWalletApk
      ? { walletArtifactSha256: await sha256File(config.resolvedWalletApk) }
      : config.wallet.packageName && managedWalletExpectedSha256(config.wallet.packageName)
        ? { walletArtifactSha256: managedWalletExpectedSha256(config.wallet.packageName)! }
        : {}),
  };
}

interface StagedPilotInputs {
  configPath: string;
  hashes: InputHashes;
  dispose(): Promise<void>;
}

async function stagePilotInputs(config: ResolvedLaunchRigConfig): Promise<StagedPilotInputs> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-inputs-"));
  await chmod(directory, 0o700);
  try {
    const configSource = await readFile(config.configPath);
    const flowSha256: Record<string, string> = {};
    const stagedScenarios = [];
    for (const scenario of config.scenarios) {
      const source = await readBoundedRegularFile(scenario.resolvedFlow, 512 * 1024);
      const stagedPath = path.join(directory, "flow-" + scenario.id + ".yaml");
      await writeFile(stagedPath, source, { flag: "wx", mode: 0o400 });
      flowSha256[scenario.id] = sha256Bytes(source);
      stagedScenarios.push({
        id: scenario.id,
        kind: scenario.kind,
        name: scenario.name,
        flow: stagedPath,
        required: scenario.required,
        timeoutMs: scenario.timeoutMs,
      });
    }

    let stagedApp: string | undefined;
    let appArtifactSha256: string | undefined;
    if (config.resolvedApk) {
      stagedApp = path.join(directory, "app.apk");
      await copyFile(config.resolvedApk, stagedApp);
      await chmod(stagedApp, 0o400);
      appArtifactSha256 = await sha256File(stagedApp);
    }
    let stagedWallet: string | undefined;
    let walletArtifactSha256 = config.wallet.packageName
      ? managedWalletExpectedSha256(config.wallet.packageName)
      : undefined;
    if (config.resolvedWalletApk) {
      stagedWallet = path.join(directory, "wallet.apk");
      await copyFile(config.resolvedWalletApk, stagedWallet);
      await chmod(stagedWallet, 0o400);
      walletArtifactSha256 = await sha256File(stagedWallet);
    }

    const stagedConfigPath = path.join(directory, "launchrig.yml");
    const stagedConfig = {
      version: 1,
      project: {
        name: config.project.name,
        packageName: config.project.packageName,
        ...(stagedApp ? { apk: stagedApp } : {}),
        install: config.project.install,
        installPolicy: config.project.installPolicy,
      },
      target: config.target,
      device: config.device,
      wallet: {
        mode: config.wallet.mode,
        ...(config.wallet.packageName ? { packageName: config.wallet.packageName } : {}),
        ...(stagedWallet ? { apk: stagedWallet } : {}),
        install: config.wallet.install,
        installPolicy: config.wallet.installPolicy,
      },
      scenarios: stagedScenarios,
      artifacts: {
        directory: config.resolvedArtifactDirectory,
        screenshots: config.artifacts.screenshots,
        retention: config.artifacts.retention,
      },
      privacy: config.privacy,
      tooling: config.tooling,
    };
    await writeFile(stagedConfigPath, stringify(stagedConfig), { encoding: "utf8", flag: "wx", mode: 0o400 });
    return {
      configPath: stagedConfigPath,
      hashes: {
        configSha256: sha256Bytes(configSource),
        flowSha256,
        ...(appArtifactSha256 ? { appArtifactSha256 } : {}),
        ...(walletArtifactSha256 ? { walletArtifactSha256 } : {}),
      },
      dispose: async () => await rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function hashesEqual(left: InputHashes, right: InputHashes): boolean {
  return sha256Value(left) === sha256Value(right);
}

interface PilotScopeEvaluation extends LoadedPilotSessionScopeV1 {
  inputsMatched: boolean;
  issues: string[];
}

function scopeDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function evaluatePilotScope(
  config: ResolvedLaunchRigConfig,
  hashes: InputHashes,
  scopePath: string,
): Promise<PilotScopeEvaluation> {
  const loaded = await loadPilotSessionScope(scopePath);
  const issues: string[] = [];
  const coreScenarios = CORE_MWA_KINDS.flatMap((kind) => {
    const scenario = config.scenarios.find((entry) => entry.kind === kind && entry.required);
    return scenario ? [scenario] : [];
  });
  if (config.scenarios.length !== CORE_MWA_KINDS.length || coreScenarios.length !== CORE_MWA_KINDS.length) {
    issues.push("Approved scope requires exactly four required core MWA scenarios");
  }
  const actualFlows: PilotSessionScopeFlow[] = coreScenarios.flatMap((scenario) => {
    const fileSha256 = hashes.flowSha256[scenario.id];
    return fileSha256
      ? [{ kind: scenario.kind as PilotSessionScopeFlow["kind"], scenarioId: scenario.id, fileSha256 }]
      : [];
  });
  if (
    actualFlows.length !== CORE_MWA_KINDS.length ||
    pilotSessionFlowReviewSha256(actualFlows) !== loaded.receipt.binding.flowReviewSha256
  ) {
    issues.push("Configured MWA flow bytes or scenario bindings do not match the approved scope");
  }
  if (hashes.configSha256 !== loaded.scope.inputs.configSha256) {
    issues.push("Configuration bytes do not match the approved scope");
  }
  if (!hashes.appArtifactSha256 || hashes.appArtifactSha256 !== loaded.scope.inputs.appBuildSha256) {
    issues.push("Configured app APK bytes do not match the approved scope");
  }
  if (
    !hashes.walletArtifactSha256 ||
    hashes.walletArtifactSha256 !== loaded.scope.inputs.walletArtifactSha256
  ) {
    issues.push("Configured development-wallet artifact digest does not match the approved scope");
  }
  if (config.target.network !== loaded.scope.policy.network) {
    issues.push("Configured network does not match the approved scope");
  }
  if (config.wallet.mode !== loaded.scope.policy.walletMode) {
    issues.push("Configured development-wallet mode does not match the approved scope");
  }
  if (config.device.requirePhysical !== loaded.scope.policy.physicalAndroidRequired) {
    issues.push("Configured physical-device policy does not match the approved scope");
  }
  if (config.artifacts.screenshots !== loaded.scope.policy.capture.screenshots) {
    issues.push("Configured screenshot policy does not match the approved scope");
  }
  if (
    config.privacy.includeLogcat !== loaded.scope.policy.capture.includeLogcat ||
    config.privacy.logcatLines !== loaded.scope.policy.capture.logcatLines
  ) {
    issues.push("Configured logcat policy does not match the approved scope");
  }
  if (config.artifacts.retention !== loaded.scope.policy.retention.maxRuns) {
    issues.push("Configured retained-run limit does not match the approved scope");
  }
  if (loaded.scope.policy.retention.expiresOn < scopeDate()) {
    issues.push("Approved scope retention window has expired");
  }
  return { ...loaded, inputsMatched: issues.length === 0, issues };
}

function approvedScopeFromRun(run: PilotRunEvidenceV1 | undefined): {
  sessionScopeSha256: string;
  sessionScopeFileSha256: string;
} | null {
  if (!run?.sessionScopeSha256 || !run.sessionScopeFileSha256) return null;
  return {
    sessionScopeSha256: run.sessionScopeSha256,
    sessionScopeFileSha256: run.sessionScopeFileSha256,
  };
}

function sameApprovedScope(
  approved: { sessionScopeSha256: string; sessionScopeFileSha256: string },
  evaluation: PilotScopeEvaluation,
): boolean {
  return (
    approved.sessionScopeSha256 === evaluation.receipt.binding.scopeSha256 &&
    approved.sessionScopeFileSha256 === evaluation.receipt.scopeFileSha256
  );
}

function executionFingerprint(run: PilotRunEvidenceV1): string {
  return sha256Value({
    configSha256: run.configSha256,
    flowSha256: run.flowSha256,
    appArtifactSha256: run.appArtifactSha256 ?? null,
    walletArtifactSha256: run.walletArtifactSha256 ?? null,
    launchRigVersion: run.launchRigVersion ?? null,
    appSnapshotSha256: run.appSnapshotSha256 ?? null,
    walletSnapshotSha256: run.walletSnapshotSha256 ?? null,
    ...(run.sessionScopeSha256
      ? {
          sessionScopeSha256: run.sessionScopeSha256,
          scopeInputsMatched: run.scopeInputsMatched,
        }
      : {}),
  });
}

function publicExecutionFingerprint(exportKey: Buffer, fingerprint: string): string {
  return createHmac("sha256", exportKey)
    .update("launchrig-public-execution-fingerprint-v2\0")
    .update(fingerprint)
    .digest("hex");
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function pilotTechnicalGate(state: PilotStateCoreV1): PilotTechnicalGate {
  const latestRun = state.runs.at(-1);
  const currentFingerprint =
    latestRun?.qualifying === true && latestRun.readiness === "Android/MWA Ready"
      ? executionFingerprint(latestRun)
      : null;
  let trailingMwaPasses = 0;
  if (currentFingerprint) {
    for (const run of [...state.runs].reverse()) {
      if (
        !run.qualifying ||
        run.readiness !== "Android/MWA Ready" ||
        executionFingerprint(run) !== currentFingerprint
      ) {
        break;
      }
      trailingMwaPasses += 1;
    }
  }
  const currentMwaDurations = currentFingerprint
    ? state.runs
        .filter(
          (run) =>
            run.qualifying &&
            run.readiness === "Android/MWA Ready" &&
            executionFingerprint(run) === currentFingerprint,
        )
        .map((run) => run.durationMs)
    : [];
  const medianRunDurationMs = median(currentMwaDurations);
  const firstMwaRun = state.runs.find(
    (run) => run.qualifying && run.readiness === "Android/MWA Ready",
  );
  const setupDurationMs = firstMwaRun
    ? Date.parse(firstMwaRun.recordedAt) - Date.parse(state.startedAt)
    : null;
  if (setupDurationMs !== null && setupDurationMs < 0) {
    throw new PilotError("Pilot MWA setup timestamps are inverted");
  }
  const setupTargetMet = setupDurationMs !== null && setupDurationMs <= SETUP_TARGET_MS;
  const runtimeTargetMet = medianRunDurationMs !== null && medianRunDurationMs <= RUNTIME_TARGET_MS;
  const repeatabilityTargetMet = trailingMwaPasses >= 3;
  return {
    profile: "external-mwa-pilot-v1",
    qualified: setupTargetMet && runtimeTargetMet && repeatabilityTargetMet,
    latestReadiness: latestRun?.readiness ?? null,
    trailingMwaPasses,
    requiredTrailingMwaPasses: 3,
    setupDurationMs,
    medianRunDurationMs,
    setupTargetMet,
    runtimeTargetMet,
    repeatabilityTargetMet,
  };
}

export function externalGrantGateStatus(): ExternalGrantGateStatus {
  return {
    status: "not-established",
    grantReady: false,
    publisherAttestation: "not-established",
    threeIndependentPublishers: "not-established",
    confirmedDefect: "not-established",
    seekerAttestation: "not-established",
    publicRelease: "not-established",
  };
}

export function pilotMetrics(state: PilotStateCoreV1): PilotMetricsV1 {
  const qualifyingRuns = state.runs.filter((run) => run.qualifying).length;
  const latestRun = state.runs.at(-1);
  const executionFingerprintSha256 = latestRun?.qualifying ? executionFingerprint(latestRun) : null;
  let consecutivePasses = 0;
  if (executionFingerprintSha256) {
    for (const run of [...state.runs].reverse()) {
      if (!run.qualifying || executionFingerprint(run) !== executionFingerprintSha256) break;
      consecutivePasses += 1;
    }
  }
  const currentQualifyingDurations = executionFingerprintSha256
    ? state.runs
        .filter((run) => run.qualifying && executionFingerprint(run) === executionFingerprintSha256)
        .map((run) => run.durationMs)
    : [];
  const medianRunDurationMs = median(currentQualifyingDurations);
  const setupDurationMs = state.firstPassingRunAt
    ? Date.parse(state.firstPassingRunAt) - Date.parse(state.startedAt)
    : null;
  if (setupDurationMs !== null && setupDurationMs < 0) throw new PilotError("Pilot setup timestamps are inverted");
  return {
    runAttempts: state.runs.length,
    qualifyingRuns,
    passRate: state.runs.length === 0 ? 0 : qualifyingRuns / state.runs.length,
    consecutivePasses,
    medianRunDurationMs,
    setupDurationMs,
    executionFingerprintSha256,
    setupTargetMet: setupDurationMs !== null && setupDurationMs <= SETUP_TARGET_MS,
    runtimeTargetMet: medianRunDurationMs !== null && medianRunDurationMs <= RUNTIME_TARGET_MS,
    repeatabilityTargetMet: consecutivePasses >= 3,
  };
}

interface ParsedPilotReport {
  runId: string;
  launchRigVersion: string;
  outcome: PilotRunEvidenceV1["outcome"];
  readiness: PilotRunEvidenceV1["readiness"];
  durationMs: number;
  reportSha256: string;
  appSnapshotSha256: string;
  walletSnapshotSha256?: string;
  physicalDevice: boolean;
  requiredChecksPassed: boolean;
}

function reportString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new PilotReportError(label + " is invalid");
  }
  return value;
}

function parseReportValue(
  value: unknown,
  config: ResolvedLaunchRigConfig,
  output: RunOutput,
  expectedHashes: InputHashes,
): ParsedPilotReport {
  if (!isRecord(value)) throw new PilotReportError("Report must be an object");
  const runId = reportString(value.runId, "Report runId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) throw new PilotReportError("Report runId is invalid");
  const launchRigVersion = reportString(value.launchRigVersion, "Report launchRigVersion");
  const outcome = value.outcome;
  if (outcome !== "passed" && outcome !== "failed" && outcome !== "setup-error") {
    throw new PilotReportError("Report outcome is invalid");
  }
  const readiness = value.readiness;
  if (readiness !== "Android Device Ready" && readiness !== "Android/MWA Ready" && readiness !== "Not Ready") {
    throw new PilotReportError("Report readiness is invalid");
  }
  if ((outcome === "passed") === (readiness === "Not Ready")) {
    throw new PilotReportError("Report readiness is inconsistent");
  }
  if (!Number.isSafeInteger(value.durationMs) || (value.durationMs as number) < 0) {
    throw new PilotReportError("Report durationMs is invalid");
  }
  if (value.schemaVersion !== 1 || value.packageName !== config.project.packageName || value.network !== config.target.network) {
    throw new PilotReportError("Report identity does not match the pilot configuration");
  }
  if (!isRecord(value.app) || value.app.packageName !== config.project.packageName) {
    throw new PilotReportError("Report app snapshot does not match the pilot configuration");
  }
  if (
    typeof value.app.apkSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.app.apkSha256) ||
    (expectedHashes.appArtifactSha256 && value.app.apkSha256 !== expectedHashes.appArtifactSha256)
  ) {
    throw new PilotReportError("Report app snapshot does not bind the installed APK");
  }
  const appSnapshotSha256 = sha256Value(value.app);
  let walletSnapshotSha256: string | undefined;
  if (outcome === "passed" && config.wallet.packageName && value.wallet === undefined) {
    throw new PilotReportError("Passing report is missing the configured wallet snapshot");
  }
  if (value.wallet !== undefined) {
    if (!isRecord(value.wallet)) throw new PilotReportError("Report wallet snapshot is invalid");
    if (config.wallet.packageName && value.wallet.packageName !== config.wallet.packageName) {
      throw new PilotReportError("Report wallet snapshot does not match the pilot configuration");
    }
    const expectedWalletSha256 = config.wallet.packageName
      ? managedWalletExpectedSha256(config.wallet.packageName)
      : undefined;
    if (
      typeof value.wallet.apkSha256 !== "string" ||
      !expectedWalletSha256 ||
      value.wallet.apkSha256 !== expectedWalletSha256 ||
      (expectedHashes.walletArtifactSha256 && value.wallet.apkSha256 !== expectedHashes.walletArtifactSha256)
    ) {
      throw new PilotReportError("Report wallet snapshot does not bind the managed test-wallet APK");
    }
    walletSnapshotSha256 = sha256Value(value.wallet);
  }
  if (!Array.isArray(value.checks) || value.checks.length === 0 || value.checks.length > 250) {
    throw new PilotReportError("Report checks are invalid");
  }
  const checks = value.checks.map((entry) => {
    if (!isRecord(entry)) throw new PilotReportError("Report check must be an object");
    const id = reportString(entry.id, "Report check ID");
    if (entry.required !== true && entry.required !== false) throw new PilotReportError("Report check required is invalid");
    if (entry.status !== "pass" && entry.status !== "fail" && entry.status !== "warn" && entry.status !== "skip") {
      throw new PilotReportError("Report check status is invalid");
    }
    return { id, required: entry.required, status: entry.status };
  });
  if (new Set(checks.map((check) => check.id)).size !== checks.length) {
    throw new PilotReportError("Report contains duplicate check IDs");
  }
  if (outcome === "passed" && readiness === "Android/MWA Ready") {
    const configuredMwaCoverageComplete = CORE_MWA_KINDS.every((kind) =>
      config.scenarios.some((scenario) => scenario.kind === kind && scenario.required),
    );
    const everyConfiguredMwaCheckPassed = config.scenarios
      .filter((scenario) => scenario.kind.startsWith("mwa-"))
      .every((scenario) => {
        const check = checks.find((entry) => entry.id === scenarioCheckId(scenario.id));
        return check?.required === scenario.required && check.status === "pass";
      });
    if (!configuredMwaCoverageComplete || !everyConfiguredMwaCheckPassed) {
      throw new PilotReportError("Report MWA readiness does not match the configured scenario results");
    }
  }
  const expectedRequiredChecks = [
    RUN_CHECK_IDS.adb,
    RUN_CHECK_IDS.deviceConnected,
    RUN_CHECK_IDS.deviceApi,
    RUN_CHECK_IDS.appInstalled,
    RUN_CHECK_IDS.appBinary,
    RUN_CHECK_IDS.maestro,
    ...(config.wallet.packageName ? [RUN_CHECK_IDS.walletInstalled, RUN_CHECK_IDS.walletBinary] : []),
    ...config.scenarios.filter((scenario) => scenario.required).map((scenario) => scenarioCheckId(scenario.id)),
  ];
  const everyExpectedCheckPassed = expectedRequiredChecks.every((id) => {
    const check = checks.find((entry) => entry.id === id);
    return check?.required === true && check.status === "pass";
  });
  const allRequiredChecksPassed = checks.filter((check) => check.required).every((check) => check.status === "pass");
  const requiredChecksPassed = everyExpectedCheckPassed && allRequiredChecksPassed;
  if (outcome === "passed" && !requiredChecksPassed) {
    throw new PilotReportError("Passing report is missing a required passing check");
  }
  if (outcome === "failed" && !checks.some((check) => check.required && check.status === "fail")) {
    throw new PilotReportError("Failed report has no required failed check");
  }
  const device = value.device;
  const physicalDevice = Boolean(
    isRecord(device) &&
      typeof device.serial === "string" &&
      device.serial.startsWith("***") &&
      device.isEmulator === false,
  );
  const expectedExitCode = outcome === "passed" ? 0 : outcome === "failed" ? 1 : 3;
  if (
    output.exitCode !== expectedExitCode ||
    output.report.runId !== runId ||
    output.report.outcome !== outcome ||
    output.report.readiness !== readiness ||
    output.report.durationMs !== value.durationMs
  ) {
    throw new PilotReportError("Report artifact and runner result are inconsistent");
  }
  return {
    runId,
    launchRigVersion,
    outcome,
    readiness,
    durationMs: value.durationMs as number,
    reportSha256: "",
    appSnapshotSha256,
    ...(walletSnapshotSha256 ? { walletSnapshotSha256 } : {}),
    physicalDevice,
    requiredChecksPassed,
  };
}

async function readPilotReport(
  output: RunOutput,
  config: ResolvedLaunchRigConfig,
  expectedHashes: InputHashes,
): Promise<ParsedPilotReport> {
  let handle;
  let bytes: Buffer;
  try {
    handle = await open(output.artifacts.json, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new PilotReportError("Report must be a regular file");
    if (metadata.size > MAX_REPORT_BYTES) throw new PilotReportError("Report exceeds the 2 MiB pilot limit");
    bytes = await handle.readFile();
  } catch (error) {
    if (error instanceof PilotReportError) throw error;
    throw new PilotReportError("Report cannot be read safely");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const source = bytes.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new PilotReportError("Report is not strict JSON");
  }
  const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) throw new PilotReportError("Report is not strict JSON");
  const expected = redactJsonValue(output.report, config.privacy.redactPatterns).value;
  if (sha256Value(value) !== sha256Value(expected)) {
    throw new PilotReportError("Report artifact and runner result are inconsistent");
  }
  return {
    ...parseReportValue(value, config, output, expectedHashes),
    reportSha256: sha256Bytes(bytes),
  };
}

function stateCoreWithRun(state: PilotStateV1, run: PilotRunEvidenceV1): PilotStateCoreV1 {
  if (state.runs.some((entry) => entry.runId === run.runId)) {
    throw new PilotError("Pilot runner returned a duplicate run ID", 3);
  }
  return {
    schemaVersion: 1,
    pilotId: state.pilotId,
    evidenceId: state.evidenceId,
    startedAt: state.startedAt,
    ...(state.firstPassingRunAt
      ? { firstPassingRunAt: state.firstPassingRunAt }
      : run.qualifying
        ? { firstPassingRunAt: run.recordedAt }
        : {}),
    runs: [...state.runs, run],
  };
}

function recordedAt(options: RunPilotOptions, state: PilotStateV1): string {
  let timestamp: string;
  try {
    timestamp = (options.now?.() ?? new Date()).toISOString();
  } catch {
    throw new PilotError("Pilot clock did not produce a valid timestamp", 3);
  }
  const previous = state.runs.at(-1)?.recordedAt ?? state.startedAt;
  if (Date.parse(timestamp) < Date.parse(previous)) throw new PilotError("Pilot clock moved backward", 3);
  return timestamp;
}

function failedAttempt(input: {
  kind: AttemptFailure;
  hashes: InputHashes;
  approvedScope: {
    sessionScopeSha256: string;
    sessionScopeFileSha256: string;
    scopeInputsMatched: boolean;
  };
  timestamp: string;
  durationMs: number;
}): PilotRunEvidenceV1 {
  return {
    runId: "attempt-" + randomUUID(),
    recordedAt: input.timestamp,
    outcome: "setup-error",
    readiness: "Not Ready",
    durationMs: Math.max(0, Math.floor(input.durationMs)),
    failureKind: input.kind,
    ...input.hashes,
    ...input.approvedScope,
    physicalDevice: false,
    requiredChecksPassed: false,
    qualifying: false,
  };
}

export interface PilotBaseOptions {
  pilotId: string;
  configPath?: string;
}

export interface StartPilotOptions extends PilotBaseOptions {
  force?: boolean;
  now?: () => Date;
}

export async function startPilot(options: StartPilotOptions): Promise<{ statePath: string; metrics: PilotMetricsV1 }> {
  assertPilotId(options.pilotId);
  const configDirectory = path.dirname(path.resolve(options.configPath ?? "launchrig.yml"));
  const statePath = await pilotStatePath(configDirectory, options.pilotId, true);
  return await withPilotLock(statePath, async () => {
    let startedAt: string;
    try {
      startedAt = (options.now?.() ?? new Date()).toISOString();
    } catch {
      throw new PilotError("Pilot clock did not produce a valid timestamp", 3);
    }
    const core: PilotStateCoreV1 = {
      schemaVersion: 1,
      pilotId: options.pilotId,
      evidenceId: randomUUID(),
      startedAt,
      runs: [],
    };
    const state = await writePilotState(statePath, core, options.force === true);
    return { statePath, metrics: pilotMetrics(state) };
  });
}

export interface PilotPreflightCheck {
  id: PilotPreflightCheckId;
  status: "pass" | "fail" | "skip";
  summary: string;
}

const PILOT_POLICY_LIMITATIONS = [
  "No pilot state, connected device, ADB, Maestro, installed package, or flow execution was checked.",
  "This local result does not establish publisher identity, consent, independence, external adoption, a confirmed defect, Seeker hardware, production-wallet behavior, Seed Vault behavior, the technical pilot gate, or grant readiness.",
] as const;

async function pilotPolicyChecks(config: ResolvedLaunchRigConfig): Promise<PilotPreflightCheck[]> {
  const projectIssues = pilotProjectIssues(config);
  const walletIssues = pilotWalletIssues(config);
  const [flowReview, appArtifactSafe, walletArtifactSafe] = await Promise.all([
    reviewPilotFlows(config),
    config.resolvedApk ? isRegularFileNoFollow(config.resolvedApk) : true,
    config.resolvedWalletApk ? isRegularFileNoFollow(config.resolvedWalletApk) : true,
  ]);
  if (!appArtifactSafe) {
    projectIssues.push("Configured app APK is missing or cannot be read safely");
  }
  if (!walletArtifactSafe) {
    walletIssues.push("Configured development-wallet APK is missing or cannot be read safely");
  }
  const checks: PilotPreflightCheck[] = [
    {
      id: PILOT_PREFLIGHT_CHECK_IDS.project,
      status: projectIssues.length === 0 ? "pass" : "fail",
      summary: projectIssues.length === 0
        ? "Project identity does not match LaunchRig's blocked default or reference-fixture identifiers"
        : projectIssues.join("; "),
    },
    {
      id: PILOT_PREFLIGHT_CHECK_IDS.wallet,
      status: walletIssues.length === 0 ? "pass" : "fail",
      summary: walletIssues.length === 0
        ? "Pilot automation uses the allowlisted " + config.wallet.mode + " development-wallet profile"
        : walletIssues.join("; "),
    },
    {
      id: PILOT_PREFLIGHT_CHECK_IDS.devicePolicy,
      status: config.device.requirePhysical ? "pass" : "fail",
      summary: config.device.requirePhysical
        ? "Pilot configuration requires a physical Android device"
        : "Pilot evidence requires device.requirePhysical: true",
    },
  ];

  checks.push({
    id: PILOT_PREFLIGHT_CHECK_IDS.flows,
    status: flowReview.promotionIssues.length === 0 ? "pass" : "fail",
    summary:
      flowReview.promotionIssues.length === 0
        ? "Every configured flow is promoted and has no reserved selector"
        : flowReview.promotionIssues.join("; "),
  });
  checks.push({
    id: PILOT_PREFLIGHT_CHECK_IDS.mwaCoverage,
    status: flowReview.coverageIssues.length === 0 ? "pass" : "fail",
    summary:
      flowReview.coverageIssues.length === 0
        ? "Required authorize, SIWS, message-signing, and rejection scenarios are configured"
        : flowReview.coverageIssues.join("; "),
  });
  return checks;
}

export interface LintPilotPolicyOptions {
  configPath?: string;
}

export interface PilotPolicyLintOutput {
  schemaVersion: 1;
  kind: "launchrig-pilot-policy-lint";
  status: "passed" | "failed";
  staticPolicyValid: boolean;
  pilotStateChecked: false;
  deviceEnvironmentChecked: false;
  checks: PilotPreflightCheck[];
  externalGrantGate: ExternalGrantGateStatus;
  grantReady: false;
  limitations: string[];
  exitCode: 0 | 2;
}

export async function lintPilotPolicy(options: LintPilotPolicyOptions = {}): Promise<PilotPolicyLintOutput> {
  const config = await loadPilotLintConfig(options.configPath ?? "launchrig.yml");
  const checks = await pilotPolicyChecks(config);
  const staticPolicyValid = checks.every((check) => check.status === "pass");
  return {
    schemaVersion: 1,
    kind: "launchrig-pilot-policy-lint",
    status: staticPolicyValid ? "passed" : "failed",
    staticPolicyValid,
    pilotStateChecked: false,
    deviceEnvironmentChecked: false,
    checks,
    externalGrantGate: externalGrantGateStatus(),
    grantReady: false,
    limitations: [...PILOT_POLICY_LIMITATIONS],
    exitCode: staticPolicyValid ? 0 : 2,
  };
}

export interface CheckPilotOptions extends PilotBaseOptions {
  scopePath: string;
  deviceSerial?: string;
  adbPath?: string;
  maestroPath?: string;
  doctorRunner?: (options: DoctorOptions) => Promise<DoctorOutput>;
}

export interface PilotCheckOutput {
  readyToRecord: boolean;
  exitCode: 0 | 2 | 3;
  statePath: string;
  checks: PilotPreflightCheck[];
  doctor?: DoctorOutput;
  technicalPilot: PilotTechnicalGate;
  externalGrantGate: ExternalGrantGateStatus;
}

export async function checkPilot(options: CheckPilotOptions): Promise<PilotCheckOutput> {
  assertPilotId(options.pilotId);
  const config = await loadCheckedConfig(options.configPath ?? "launchrig.yml");
  const statePath = await readOnlyPilotStatePath(config.configDirectory, options.pilotId);
  const state = await readPilotState(statePath);
  if (state.pilotId !== options.pilotId) throw new PilotError("Pilot state ID does not match its directory", 3);
  const scope = await evaluatePilotScope(config, await inputHashes(config), options.scopePath);

  const checks: PilotPreflightCheck[] = [
    {
      id: PILOT_PREFLIGHT_CHECK_IDS.state,
      status: "pass",
      summary: "Private pilot state exists and its integrity check passed",
    },
    ...(await pilotPolicyChecks(config)),
  ];
  const scopeIssues = [...scope.issues];
  const existingScope = approvedScopeFromRun(state.runs[0]);
  if (state.runs.length > 0 && !existingScope) {
    scopeIssues.push("Existing pilot state contains legacy unscoped attempts; start a new pilot ID");
  } else if (existingScope && !sameApprovedScope(existingScope, scope)) {
    scopeIssues.push("Private scope file does not match the scope already bound to this pilot state");
  }
  const projectCheck = checks.find((entry) => entry.id === PILOT_PREFLIGHT_CHECK_IDS.project);
  if (!projectCheck) throw new PilotError("Pilot project preflight check is missing", 3);
  if (scopeIssues.length > 0) {
    projectCheck.status = "fail";
    projectCheck.summary = scopeIssues.join("; ");
  } else {
    projectCheck.summary += "; exact config, APK, four-flow, and enforceable policy inputs match the private scope";
  }

  const policyReady = checks.every((check) => check.status === "pass");
  let doctorOutput: DoctorOutput | undefined;
  if (policyReady) {
    const runDoctor = options.doctorRunner ?? doctor;
    doctorOutput = await runDoctor({
      configPath: config.configPath,
      ...(options.deviceSerial ? { deviceSerial: options.deviceSerial } : {}),
      ...(options.adbPath ? { adbPath: options.adbPath } : {}),
      ...(options.maestroPath ? { maestroPath: options.maestroPath } : {}),
      verifyInstalledArtifactHashes: true,
    });
    checks.push({
      id: PILOT_PREFLIGHT_CHECK_IDS.environment,
      status: doctorOutput.ok ? "pass" : "fail",
      summary: doctorOutput.ok
        ? "Physical Android device, invoked tools, and exact package binaries are ready"
        : doctorOutput.issues.join("; "),
    });
  } else {
    checks.push({
      id: PILOT_PREFLIGHT_CHECK_IDS.environment,
      status: "skip",
      summary: "Environment checks were skipped until the pilot policy issues are fixed",
    });
  }

  const exitCode: 0 | 2 | 3 = !policyReady ? 2 : doctorOutput?.ok ? 0 : 3;
  return {
    readyToRecord: exitCode === 0,
    exitCode,
    statePath,
    checks,
    ...(doctorOutput ? { doctor: doctorOutput } : {}),
    technicalPilot: pilotTechnicalGate(state),
    externalGrantGate: externalGrantGateStatus(),
  };
}

export interface RunPilotOptions extends PilotBaseOptions {
  scopePath: string;
  repeat?: number;
  runOptions?: RunOptions;
  projectRunner?: PilotProjectRunner;
  now?: () => Date;
}

export async function runPilot(
  options: RunPilotOptions,
): Promise<{
  statePath: string;
  runs: PilotRunEvidenceV1[];
  metrics: PilotMetricsV1;
  technicalPilot: PilotTechnicalGate;
  externalGrantGate: ExternalGrantGateStatus;
  exitCode: 0 | 1 | 3;
}> {
  assertPilotId(options.pilotId);
  const repeat = options.repeat ?? 1;
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 10) {
    throw new PilotError("Pilot repeat must be an integer from 1 to 10");
  }
  if (options.runOptions?.scenarioId) {
    throw new PilotError("Pilot runs must execute every configured scenario");
  }
  const config = await loadEligibleConfig(options.configPath ?? "launchrig.yml");
  await assertPilotFlowPolicy(config);
  let lastKnownHashes = await inputHashes(config);
  const initialScope = await evaluatePilotScope(config, lastKnownHashes, options.scopePath);
  const statePath = await pilotStatePath(config.configDirectory, options.pilotId);
  const runner = options.projectRunner ?? runProject;

  return await withPilotLock(statePath, async () => {
    let state = await readPilotState(statePath);
    if (state.pilotId !== options.pilotId) throw new PilotError("Pilot state ID does not match its directory", 3);
    if (state.runs.length > 0 && !approvedScopeFromRun(state.runs[0])) {
      throw new PilotError("Existing pilot state contains legacy unscoped attempts; start a new pilot ID");
    }
    const approvedScope = approvedScopeFromRun(state.runs[0]) ?? {
      sessionScopeSha256: initialScope.receipt.binding.scopeSha256,
      sessionScopeFileSha256: initialScope.receipt.scopeFileSha256,
    };
    const retainedRunLimit = Math.min(100, initialScope.scope.policy.retention.maxRuns);
    if (state.runs.length + repeat > retainedRunLimit) {
      throw new PilotError("Pilot repeat would exceed the approved retained-run limit");
    }
    const recorded: PilotRunEvidenceV1[] = [];
    const finish = () => {
      const exitCode: 0 | 1 | 3 = recorded.some((run) => run.outcome === "setup-error")
        ? 3
        : recorded.every((run) => run.qualifying)
          ? 0
          : 1;
      return {
        statePath,
        runs: recorded,
        metrics: pilotMetrics(state),
        technicalPilot: pilotTechnicalGate(state),
        externalGrantGate: externalGrantGateStatus(),
        exitCode,
      };
    };
    const appendFailedAttempt = async (
      kind: AttemptFailure,
      hashes: InputHashes,
      scopeInputsMatched: boolean,
      attemptStartedAt: number,
    ): Promise<void> => {
      const run = failedAttempt({
        kind,
        hashes,
        approvedScope: { ...approvedScope, scopeInputsMatched },
        timestamp: recordedAt(options, state),
        durationMs: Date.now() - attemptStartedAt,
      });
      state = await writePilotState(statePath, stateCoreWithRun(state, run), true);
      recorded.push(run);
    };

    if (!initialScope.inputsMatched || !sameApprovedScope(approvedScope, initialScope)) {
      await appendFailedAttempt("scope-mismatch", lastKnownHashes, false, Date.now());
      return finish();
    }

    for (let index = 0; index < repeat; index += 1) {
      const attemptStartedAt = Date.now();
      let attemptConfig: ResolvedLaunchRigConfig;
      let staged: StagedPilotInputs;
      try {
        const configSha256BeforeLoad = await sha256File(config.configPath);
        attemptConfig = await loadEligibleConfig(config.configPath);
        await assertPilotFlowPolicy(attemptConfig);
        staged = await stagePilotInputs(attemptConfig);
        if (configSha256BeforeLoad !== staged.hashes.configSha256) {
          await staged.dispose();
          throw new Error("Pilot configuration changed while it was being loaded");
        }
      } catch {
        await appendFailedAttempt("input-mutation", lastKnownHashes, false, attemptStartedAt);
        break;
      }
      const before = staged.hashes;
      lastKnownHashes = before;
      let beforeScope: PilotScopeEvaluation | undefined;
      try {
        beforeScope = await evaluatePilotScope(attemptConfig, before, options.scopePath);
      } catch {
        beforeScope = undefined;
      }
      if (!beforeScope || !beforeScope.inputsMatched || !sameApprovedScope(approvedScope, beforeScope)) {
        await staged.dispose();
        await appendFailedAttempt("scope-mismatch", before, false, attemptStartedAt);
        break;
      }
      let output: RunOutput;
      try {
        output = await runner(staged.configPath, {
          ...options.runOptions,
          requireInstalledArtifactHashes: true,
        });
      } catch {
        await staged.dispose();
        await appendFailedAttempt("runner-error", before, true, attemptStartedAt);
        break;
      }

      let after: InputHashes | undefined;
      let afterScope: PilotScopeEvaluation | undefined;
      try {
        after = await inputHashes(attemptConfig);
      } catch {
        after = undefined;
      }
      if (after) {
        try {
          afterScope = await evaluatePilotScope(attemptConfig, after, options.scopePath);
        } catch {
          afterScope = undefined;
        }
      }
      try {
        await staged.dispose();
      } catch {
        throw new PilotError("Pilot staged inputs cannot be removed safely", 3);
      }
      if (!after || !hashesEqual(before, after)) {
        await appendFailedAttempt("input-mutation", before, false, attemptStartedAt);
        break;
      }
      if (!afterScope || !afterScope.inputsMatched || !sameApprovedScope(approvedScope, afterScope)) {
        await appendFailedAttempt("scope-mismatch", before, false, attemptStartedAt);
        break;
      }

      let parsed: ParsedPilotReport;
      try {
        parsed = await readPilotReport(output, attemptConfig, before);
      } catch {
        await appendFailedAttempt("report-invalid", before, true, attemptStartedAt);
        break;
      }
      const timestamp = recordedAt(options, state);
      const qualifying =
        parsed.outcome === "passed" && parsed.requiredChecksPassed && parsed.physicalDevice;
      const run: PilotRunEvidenceV1 = {
        runId: parsed.runId,
        recordedAt: timestamp,
        outcome: parsed.outcome,
        readiness: parsed.readiness,
        durationMs: parsed.durationMs,
        reportSha256: parsed.reportSha256,
        ...before,
        launchRigVersion: parsed.launchRigVersion,
        appSnapshotSha256: parsed.appSnapshotSha256,
        ...(parsed.walletSnapshotSha256 ? { walletSnapshotSha256: parsed.walletSnapshotSha256 } : {}),
        ...approvedScope,
        scopeInputsMatched: true,
        physicalDevice: parsed.physicalDevice,
        requiredChecksPassed: parsed.requiredChecksPassed,
        qualifying,
      };
      state = await writePilotState(statePath, stateCoreWithRun(state, run), true);
      recorded.push(run);
      if (run.outcome === "setup-error") break;
    }
    return finish();
  });
}

export async function getPilotStatus(options: PilotBaseOptions): Promise<{
  statePath: string;
  metrics: PilotMetricsV1;
  technicalPilot: PilotTechnicalGate;
  externalGrantGate: ExternalGrantGateStatus;
}> {
  assertPilotId(options.pilotId);
  const config = await loadEligibleConfig(options.configPath ?? "launchrig.yml");
  const statePath = await pilotStatePath(config.configDirectory, options.pilotId);
  const state = await readPilotState(statePath);
  if (state.pilotId !== options.pilotId) throw new PilotError("Pilot state ID does not match its directory", 3);
  return {
    statePath,
    metrics: pilotMetrics(state),
    technicalPilot: pilotTechnicalGate(state),
    externalGrantGate: externalGrantGateStatus(),
  };
}

export interface ExportPilotOptions extends PilotBaseOptions {
  outputPath?: string;
  force?: boolean;
}

async function writePublicEvidence(outputPath: string, source: string, force: boolean): Promise<void> {
  if (!force) {
    try {
      await writeFile(outputPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      if (isRecord(error) && error.code === "EEXIST") {
        throw new PilotError("Pilot export already exists; use --force only to replace it");
      }
      throw new PilotError("Pilot export cannot be written", 3);
    }
  }
  const temporaryPath = outputPath + "." + randomUUID() + ".part";
  try {
    await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, outputPath);
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    throw new PilotError("Pilot export cannot be replaced", 3);
  }
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function isProtectedPilotPath(pilotsRoot: string, target: string): boolean {
  if (!isContained(pilotsRoot, target)) return false;
  const segments = path.relative(pilotsRoot, target).split(path.sep);
  return segments.length >= 2 && (segments[1] ?? "").toLowerCase().startsWith("evidence.json");
}

async function resolveThroughExistingAncestor(target: string): Promise<string> {
  let current = target;
  const missingSegments: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(current), ...missingSegments);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw new PilotError("Pilot export destination cannot be resolved", 3);
      }
      const parent = path.dirname(current);
      if (parent === current) throw new PilotError("Pilot export destination cannot be resolved", 3);
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function assertSafePublicExportDestination(configDirectory: string, outputPath: string): Promise<void> {
  const pilotsRoot = await realpath(path.join(configDirectory, ".launchrig", "pilots")).catch(() => {
    throw new PilotError("Pilot state directory cannot be resolved", 3);
  });
  const canonicalDestination = await resolveThroughExistingAncestor(outputPath);
  if (isProtectedPilotPath(pilotsRoot, canonicalDestination)) {
    throw new PilotError("Pilot export cannot replace private state or lock files");
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
}

export async function exportPilotEvidence(
  options: ExportPilotOptions,
): Promise<{ outputPath: string; evidence: PublicPilotEvidenceV2 | PublicPilotEvidenceV3 }> {
  assertPilotId(options.pilotId);
  const config = await loadEligibleConfig(options.configPath ?? "launchrig.yml");
  const statePath = await pilotStatePath(config.configDirectory, options.pilotId);
  const state = await readPilotState(statePath);
  if (state.pilotId !== options.pilotId) throw new PilotError("Pilot state ID does not match its directory", 3);
  const privateMetrics = pilotMetrics(state);
  const publicFingerprintKey = randomBytes(32);
  const metrics: PilotMetricsV1 = {
    ...privateMetrics,
    executionFingerprintSha256: privateMetrics.executionFingerprintSha256
      ? publicExecutionFingerprint(publicFingerprintKey, privateMetrics.executionFingerprintSha256)
      : null,
  };
  const technicalPilot = pilotTechnicalGate(state);
  let previousElapsedSinceStartMs = 0;
  const scopeEnforced = state.runs.length > 0 && state.runs.every((run) => run.sessionScopeSha256 !== undefined);
  const sessionScopeSha256 = scopeEnforced ? state.runs[0]?.sessionScopeSha256 : undefined;
  if (scopeEnforced && !sessionScopeSha256) throw new PilotError("Scoped pilot state is missing its scope digest", 3);
  const publicRuns = state.runs.map((run, index) => {
    const elapsedSinceStartMs = Date.parse(run.recordedAt) - Date.parse(state.startedAt);
    if (
      elapsedSinceStartMs < previousElapsedSinceStartMs ||
      elapsedSinceStartMs - previousElapsedSinceStartMs < run.durationMs
    ) {
      throw new PilotError("Pilot run timestamps do not cover sequential run durations", 3);
    }
    previousElapsedSinceStartMs = elapsedSinceStartMs;
    return {
      runId: "run-" + String(index + 1).padStart(3, "0"),
      outcome: run.outcome,
      readiness: run.readiness,
      durationMs: run.durationMs,
      elapsedSinceStartMs,
      executionFingerprintSha256: run.failureKind
        ? null
        : publicExecutionFingerprint(publicFingerprintKey, executionFingerprint(run)),
      ...(run.failureKind ? { failureKind: run.failureKind } : {}),
      ...(run.launchRigVersion ? { launchRigVersion: run.launchRigVersion } : {}),
      ...(scopeEnforced
        ? {
            sessionScopeSha256: run.sessionScopeSha256!,
            scopeInputsMatched: run.scopeInputsMatched!,
          }
        : {}),
      physicalDevice: run.physicalDevice,
      requiredChecksPassed: run.requiredChecksPassed,
      qualifying: run.qualifying,
    };
  });
  const common = {
    kind: "launchrig-pilot-evidence" as const,
    evidenceId: state.evidenceId,
    claimStatus: "self-recorded-unattested" as const,
    metrics,
    technicalPilot,
    runs: publicRuns,
    claims: {
      externalPublisher: "not-established" as const,
      seekerHardware: "not-established" as const,
      productionWallet: "not-established" as const,
      seedVault: "not-established" as const,
      confirmedDefect: "not-established" as const,
    },
  };
  publicFingerprintKey.fill(0);
  const evidence: PublicPilotEvidenceV2 | PublicPilotEvidenceV3 = scopeEnforced
    ? (() => {
        const core: Omit<PublicPilotEvidenceV3, "evidenceSha256"> = {
          schemaVersion: 3,
          ...common,
          sessionScope: {
            profile: "external-mwa-pilot-scope-v1",
            scopeSha256: sessionScopeSha256!,
            claimStatus: "operator-prepared-unattested",
          },
          runs: publicRuns as PublicPilotEvidenceV3["runs"],
        };
        return { ...core, evidenceSha256: sha256Value(core) };
      })()
    : (() => {
        const core: Omit<PublicPilotEvidenceV2, "evidenceSha256"> = {
          schemaVersion: 2,
          ...common,
          runs: publicRuns,
        };
        return { ...core, evidenceSha256: sha256Value(core) };
      })();
  const outputPath = path.resolve(
    config.configDirectory,
    options.outputPath ?? path.join(path.dirname(statePath), "public-evidence.json"),
  );
  await assertSafePublicExportDestination(config.configDirectory, outputPath);
  await writePublicEvidence(outputPath, JSON.stringify(evidence, null, 2) + "\n", options.force === true);
  return { outputPath, evidence };
}

export { PilotError } from "../pilot/store.js";
