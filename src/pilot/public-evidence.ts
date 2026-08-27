import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { parseDocument } from "yaml";
import type {
  PilotMetricsV1,
  PilotTechnicalGate,
  PublicPilotClaims,
  PublicPilotEvidence,
  PublicPilotEvidenceV1,
  PublicPilotEvidenceV2,
  PublicPilotRunV1,
  PublicPilotRunV2,
} from "./types.js";
import { PilotError, sha256Value } from "./store.js";

const MAX_PUBLIC_EVIDENCE_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SETUP_TARGET_MS = 30 * 60 * 1000;
const RUNTIME_TARGET_MS = 10 * 60 * 1000;

export const PUBLIC_EVIDENCE_V1_LIMITATIONS = [
  "The integrity digest is not a signature or proof of publisher identity.",
  "Evidence v1 omits per-run fingerprints, so fingerprint-specific consecutive passes and median runtime cannot be independently recomputed.",
  "Evidence v1 omits timestamps, so setup duration cannot be independently recomputed.",
  "Evidence v1 cannot establish the strict external-MWA technical gate from its public fields.",
  "Physical-device and required-check flags are self-recorded values, not device attestations.",
  "Publisher independence, Seeker hardware, production wallets, Seed Vault, and confirmed defects remain not established.",
] as const;

export const PUBLIC_EVIDENCE_V2_LIMITATIONS = [
  "The integrity digest is not a signature or proof of publisher identity.",
  "The technical pilot result is recomputed from self-recorded fields and is not an independent attestation.",
  "Relative run timing reveals cadence, and reexports of the same pilot remain linkable through their stable evidence ID.",
  "A fresh export key prevents direct token comparison, but visible timing and group patterns can still support correlation.",
  "Physical-device and required-check flags are self-recorded values, not device attestations.",
  "Publisher consent, publisher usability, and external critical-defect status remain not established.",
  "Publisher independence, Seeker hardware, production wallets, Seed Vault, and confirmed defects remain not established.",
] as const;

export const PUBLIC_EVIDENCE_LIMITATIONS = PUBLIC_EVIDENCE_V1_LIMITATIONS;

export interface VerifiedPublicPilotEvidence {
  schemaVersion: 1 | 2;
  evidenceId: string;
  integrityValid: true;
  internalConsistencyValid: true;
  claimStatus: "self-recorded-unattested";
  metrics: PilotMetricsV1;
  technicalPilot: PilotTechnicalGate | null;
  reportedTechnicalTargetsMet: boolean;
  grantReady: false;
  limitations: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new PilotError(label + " must be an object");
  return value;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new PilotError(label + " contains unsupported fields");
  }
}

function requiredString(value: unknown, label: string, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new PilotError(label + " is invalid");
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new PilotError(label + " must be a boolean");
  return value;
}

function requiredInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new PilotError(label + " must be a bounded non-negative integer");
  }
  return value as number;
}

function requiredNumber(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new PilotError(label + " must be a bounded finite number");
  }
  return value;
}

function nullableInteger(value: unknown, label: string, maximum: number): number | null {
  return value === null ? null : requiredInteger(value, label, maximum);
}

function nullableNumber(value: unknown, label: string, maximum: number): number | null {
  return value === null ? null : requiredNumber(value, label, maximum);
}

function strictSha256(value: unknown, label: string): string {
  const digest = requiredString(value, label, 64);
  if (!SHA256.test(digest)) throw new PilotError(label + " must be a lowercase SHA-256 digest");
  return digest;
}

function parseReadiness(value: unknown, label: string): PublicPilotRunV1["readiness"] {
  if (value !== "Android Device Ready" && value !== "Android/MWA Ready" && value !== "Not Ready") {
    throw new PilotError(label + " is invalid");
  }
  return value;
}

function parseMetrics(value: unknown): PilotMetricsV1 {
  const metrics = assertRecord(value, "Public evidence metrics");
  assertKeys(
    metrics,
    [
      "runAttempts",
      "qualifyingRuns",
      "passRate",
      "consecutivePasses",
      "medianRunDurationMs",
      "setupDurationMs",
      "executionFingerprintSha256",
      "setupTargetMet",
      "runtimeTargetMet",
      "repeatabilityTargetMet",
    ],
    "Public evidence metrics",
  );
  return {
    runAttempts: requiredInteger(metrics.runAttempts, "Public evidence runAttempts", 100),
    qualifyingRuns: requiredInteger(metrics.qualifyingRuns, "Public evidence qualifyingRuns", 100),
    passRate: requiredNumber(metrics.passRate, "Public evidence passRate", 1),
    consecutivePasses: requiredInteger(metrics.consecutivePasses, "Public evidence consecutivePasses", 100),
    medianRunDurationMs: nullableNumber(
      metrics.medianRunDurationMs,
      "Public evidence medianRunDurationMs",
      Number.MAX_SAFE_INTEGER,
    ),
    setupDurationMs: nullableInteger(
      metrics.setupDurationMs,
      "Public evidence setupDurationMs",
      Number.MAX_SAFE_INTEGER,
    ),
    executionFingerprintSha256:
      metrics.executionFingerprintSha256 === null
        ? null
        : strictSha256(metrics.executionFingerprintSha256, "Public evidence execution fingerprint"),
    setupTargetMet: requiredBoolean(metrics.setupTargetMet, "Public evidence setupTargetMet"),
    runtimeTargetMet: requiredBoolean(metrics.runtimeTargetMet, "Public evidence runtimeTargetMet"),
    repeatabilityTargetMet: requiredBoolean(
      metrics.repeatabilityTargetMet,
      "Public evidence repeatabilityTargetMet",
    ),
  };
}

const RUN_V1_KEYS = [
  "runId",
  "outcome",
  "readiness",
  "durationMs",
  "failureKind",
  "launchRigVersion",
  "physicalDevice",
  "requiredChecksPassed",
  "qualifying",
] as const;

const RUN_V2_KEYS = [...RUN_V1_KEYS, "elapsedSinceStartMs", "executionFingerprintSha256"] as const;

function parseRunCore(
  value: unknown,
  index: number,
  allowedKeys: readonly string[],
): { source: Record<string, unknown>; run: PublicPilotRunV1 } {
  const source = assertRecord(value, "Public evidence run");
  assertKeys(source, allowedKeys, "Public evidence run");
  const expectedRunId = "run-" + String(index + 1).padStart(3, "0");
  if (source.runId !== expectedRunId) throw new PilotError("Public evidence run IDs must be sequential");
  const outcome = source.outcome;
  if (outcome !== "passed" && outcome !== "failed" && outcome !== "setup-error") {
    throw new PilotError("Public evidence run outcome is invalid");
  }
  const readiness = parseReadiness(source.readiness, "Public evidence run readiness");
  if ((outcome === "passed") === (readiness === "Not Ready")) {
    throw new PilotError("Public evidence run readiness is inconsistent");
  }
  const physicalDevice = requiredBoolean(source.physicalDevice, "Public evidence physicalDevice");
  const requiredChecksPassed = requiredBoolean(
    source.requiredChecksPassed,
    "Public evidence requiredChecksPassed",
  );
  const qualifying = requiredBoolean(source.qualifying, "Public evidence qualifying");
  if (qualifying !== (outcome === "passed" && physicalDevice && requiredChecksPassed)) {
    throw new PilotError("Public evidence qualifying state is inconsistent");
  }
  const run: PublicPilotRunV1 = {
    runId: expectedRunId,
    outcome,
    readiness,
    durationMs: requiredInteger(source.durationMs, "Public evidence run durationMs", Number.MAX_SAFE_INTEGER),
    physicalDevice,
    requiredChecksPassed,
    qualifying,
  };
  if (source.failureKind !== undefined) {
    const failureKind = source.failureKind;
    if (failureKind !== "runner-error" && failureKind !== "input-mutation" && failureKind !== "report-invalid") {
      throw new PilotError("Public evidence failureKind is invalid");
    }
    if (outcome !== "setup-error" || readiness !== "Not Ready" || physicalDevice || requiredChecksPassed || qualifying) {
      throw new PilotError("Public evidence failed attempt is inconsistent");
    }
    run.failureKind = failureKind;
  }
  if (source.launchRigVersion !== undefined) {
    run.launchRigVersion = requiredString(source.launchRigVersion, "Public evidence LaunchRig version", 64);
  }
  if (run.failureKind === undefined && run.launchRigVersion === undefined) {
    throw new PilotError("Public evidence completed run must include a LaunchRig version");
  }
  return { source, run };
}

function parseRunV1(value: unknown, index: number): PublicPilotRunV1 {
  return parseRunCore(value, index, RUN_V1_KEYS).run;
}

function parseRunV2(value: unknown, index: number): PublicPilotRunV2 {
  const { source, run } = parseRunCore(value, index, RUN_V2_KEYS);
  const elapsedSinceStartMs = requiredInteger(
    source.elapsedSinceStartMs,
    "Public evidence elapsedSinceStartMs",
    Number.MAX_SAFE_INTEGER,
  );
  const executionFingerprintSha256 =
    source.executionFingerprintSha256 === null
      ? null
      : strictSha256(source.executionFingerprintSha256, "Public evidence run execution fingerprint");
  if ((run.failureKind !== undefined) !== (executionFingerprintSha256 === null)) {
    throw new PilotError("Public evidence run execution fingerprint is inconsistent");
  }
  return { ...run, elapsedSinceStartMs, executionFingerprintSha256 };
}

function parseClaims(value: unknown): PublicPilotClaims {
  const claims = assertRecord(value, "Public evidence claims");
  const keys = ["externalPublisher", "seekerHardware", "productionWallet", "seedVault", "confirmedDefect"];
  assertKeys(claims, keys, "Public evidence claims");
  for (const key of keys) {
    if (claims[key] !== "not-established") throw new PilotError("Public evidence claims must remain not-established");
  }
  return {
    externalPublisher: "not-established",
    seekerHardware: "not-established",
    productionWallet: "not-established",
    seedVault: "not-established",
    confirmedDefect: "not-established",
  };
}

function parseTechnicalPilot(value: unknown): PilotTechnicalGate {
  const technical = assertRecord(value, "Public evidence technical pilot");
  assertKeys(
    technical,
    [
      "profile",
      "qualified",
      "latestReadiness",
      "trailingMwaPasses",
      "requiredTrailingMwaPasses",
      "setupDurationMs",
      "medianRunDurationMs",
      "setupTargetMet",
      "runtimeTargetMet",
      "repeatabilityTargetMet",
    ],
    "Public evidence technical pilot",
  );
  if (technical.profile !== "external-mwa-pilot-v1") {
    throw new PilotError("Public evidence technical profile is invalid");
  }
  if (technical.requiredTrailingMwaPasses !== 3) {
    throw new PilotError("Public evidence required trailing MWA passes must be 3");
  }
  return {
    profile: "external-mwa-pilot-v1",
    qualified: requiredBoolean(technical.qualified, "Public evidence technical qualified"),
    latestReadiness:
      technical.latestReadiness === null
        ? null
        : parseReadiness(technical.latestReadiness, "Public evidence technical latestReadiness"),
    trailingMwaPasses: requiredInteger(
      technical.trailingMwaPasses,
      "Public evidence trailingMwaPasses",
      100,
    ),
    requiredTrailingMwaPasses: 3,
    setupDurationMs: nullableInteger(
      technical.setupDurationMs,
      "Public evidence technical setupDurationMs",
      Number.MAX_SAFE_INTEGER,
    ),
    medianRunDurationMs: nullableNumber(
      technical.medianRunDurationMs,
      "Public evidence technical medianRunDurationMs",
      Number.MAX_SAFE_INTEGER,
    ),
    setupTargetMet: requiredBoolean(technical.setupTargetMet, "Public evidence technical setupTargetMet"),
    runtimeTargetMet: requiredBoolean(technical.runtimeTargetMet, "Public evidence technical runtimeTargetMet"),
    repeatabilityTargetMet: requiredBoolean(
      technical.repeatabilityTargetMet,
      "Public evidence technical repeatabilityTargetMet",
    ),
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function metricsFromV2Runs(runs: readonly PublicPilotRunV2[]): PilotMetricsV1 {
  const qualifyingRuns = runs.filter((run) => run.qualifying).length;
  const latestRun = runs.at(-1);
  const currentFingerprint = latestRun?.qualifying === true ? latestRun.executionFingerprintSha256 : null;
  let consecutivePasses = 0;
  if (currentFingerprint) {
    for (const run of [...runs].reverse()) {
      if (!run.qualifying || run.executionFingerprintSha256 !== currentFingerprint) break;
      consecutivePasses += 1;
    }
  }
  const currentDurations = currentFingerprint
    ? runs
        .filter((run) => run.qualifying && run.executionFingerprintSha256 === currentFingerprint)
        .map((run) => run.durationMs)
    : [];
  const medianRunDurationMs = median(currentDurations);
  const setupDurationMs = runs.find((run) => run.qualifying)?.elapsedSinceStartMs ?? null;
  return {
    runAttempts: runs.length,
    qualifyingRuns,
    passRate: runs.length === 0 ? 0 : qualifyingRuns / runs.length,
    consecutivePasses,
    medianRunDurationMs,
    setupDurationMs,
    executionFingerprintSha256: currentFingerprint,
    setupTargetMet: setupDurationMs !== null && setupDurationMs <= SETUP_TARGET_MS,
    runtimeTargetMet: medianRunDurationMs !== null && medianRunDurationMs <= RUNTIME_TARGET_MS,
    repeatabilityTargetMet: consecutivePasses >= 3,
  };
}

function technicalPilotFromV2Runs(runs: readonly PublicPilotRunV2[]): PilotTechnicalGate {
  const latestRun = runs.at(-1);
  const currentFingerprint =
    latestRun?.qualifying === true && latestRun.readiness === "Android/MWA Ready"
      ? latestRun.executionFingerprintSha256
      : null;
  let trailingMwaPasses = 0;
  if (currentFingerprint) {
    for (const run of [...runs].reverse()) {
      if (
        !run.qualifying ||
        run.readiness !== "Android/MWA Ready" ||
        run.executionFingerprintSha256 !== currentFingerprint
      ) {
        break;
      }
      trailingMwaPasses += 1;
    }
  }
  const currentMwaDurations = currentFingerprint
    ? runs
        .filter(
          (run) =>
            run.qualifying &&
            run.readiness === "Android/MWA Ready" &&
            run.executionFingerprintSha256 === currentFingerprint,
        )
        .map((run) => run.durationMs)
    : [];
  const medianRunDurationMs = median(currentMwaDurations);
  const setupDurationMs =
    runs.find((run) => run.qualifying && run.readiness === "Android/MWA Ready")?.elapsedSinceStartMs ?? null;
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

function assertV1MetricSemantics(metrics: PilotMetricsV1, runs: readonly PublicPilotRunV1[]): void {
  const qualifyingRuns = runs.filter((run) => run.qualifying).length;
  const expectedPassRate = runs.length === 0 ? 0 : qualifyingRuns / runs.length;
  if (
    metrics.runAttempts !== runs.length ||
    metrics.qualifyingRuns !== qualifyingRuns ||
    metrics.qualifyingRuns > metrics.runAttempts ||
    metrics.passRate !== expectedPassRate
  ) {
    throw new PilotError("Public evidence aggregate run metrics are inconsistent");
  }

  let trailingQualifyingRuns = 0;
  for (const run of [...runs].reverse()) {
    if (!run.qualifying) break;
    trailingQualifyingRuns += 1;
  }
  if (metrics.consecutivePasses > trailingQualifyingRuns) {
    throw new PilotError("Public evidence consecutive passes exceed the visible trailing passes");
  }

  const latestRun = runs.at(-1);
  if (metrics.executionFingerprintSha256 === null) {
    if (metrics.consecutivePasses !== 0 || metrics.medianRunDurationMs !== null || latestRun?.qualifying === true) {
      throw new PilotError("Public evidence current fingerprint metrics are inconsistent");
    }
  } else if (
    latestRun?.qualifying !== true ||
    metrics.consecutivePasses < 1 ||
    metrics.medianRunDurationMs === null
  ) {
    throw new PilotError("Public evidence current fingerprint metrics are inconsistent");
  }

  const qualifyingDurations = runs.filter((run) => run.qualifying).map((run) => run.durationMs);
  if (metrics.medianRunDurationMs !== null && qualifyingDurations.length > 0) {
    const minimumDuration = Math.min(...qualifyingDurations);
    const maximumDuration = Math.max(...qualifyingDurations);
    if (metrics.medianRunDurationMs < minimumDuration || metrics.medianRunDurationMs > maximumDuration) {
      throw new PilotError("Public evidence median runtime is inconsistent with visible qualifying runs");
    }
    if (metrics.consecutivePasses === qualifyingRuns) {
      const visibleMedian = median(qualifyingDurations);
      if (metrics.medianRunDurationMs !== visibleMedian) {
        throw new PilotError("Public evidence median runtime is inconsistent with visible qualifying runs");
      }
    }
  }

  if ((qualifyingRuns === 0) !== (metrics.setupDurationMs === null)) {
    throw new PilotError("Public evidence setup duration is inconsistent");
  }
  if (metrics.setupTargetMet !== (metrics.setupDurationMs !== null && metrics.setupDurationMs <= SETUP_TARGET_MS)) {
    throw new PilotError("Public evidence setup target is inconsistent");
  }
  if (
    metrics.runtimeTargetMet !==
    (metrics.medianRunDurationMs !== null && metrics.medianRunDurationMs <= RUNTIME_TARGET_MS)
  ) {
    throw new PilotError("Public evidence runtime target is inconsistent");
  }
  if (metrics.repeatabilityTargetMet !== (metrics.consecutivePasses >= 3)) {
    throw new PilotError("Public evidence repeatability target is inconsistent");
  }
}

function assertSequentialOffsets(runs: readonly PublicPilotRunV2[]): void {
  let previous = 0;
  for (const run of runs) {
    if (run.elapsedSinceStartMs < previous) {
      throw new PilotError("Public evidence elapsed run offsets must be nondecreasing");
    }
    if (run.elapsedSinceStartMs - previous < run.durationMs) {
      throw new PilotError("Public evidence elapsed run offsets cannot overlap sequential run durations");
    }
    previous = run.elapsedSinceStartMs;
  }
}

function parseCommonHeader(
  evidence: Record<string, unknown>,
  schemaVersion: 1 | 2,
): { evidenceId: string; claims: PublicPilotClaims; evidenceSha256: string } {
  if (evidence.schemaVersion !== schemaVersion || evidence.kind !== "launchrig-pilot-evidence") {
    throw new PilotError("Public evidence schema identity is invalid");
  }
  const evidenceId = requiredString(evidence.evidenceId, "Public evidence ID", 36);
  if (!UUID_V4.test(evidenceId)) throw new PilotError("Public evidence ID must be a lowercase UUIDv4");
  if (evidence.claimStatus !== "self-recorded-unattested") {
    throw new PilotError("Public evidence claim status must remain self-recorded-unattested");
  }
  return {
    evidenceId,
    claims: parseClaims(evidence.claims),
    evidenceSha256: strictSha256(evidence.evidenceSha256, "Public evidence integrity digest"),
  };
}

function assertRunArray(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new PilotError("Public evidence runs must be an array with at most 100 entries");
  }
}

function parsePublicEvidenceV1(value: Record<string, unknown>): PublicPilotEvidenceV1 {
  assertKeys(
    value,
    ["schemaVersion", "kind", "evidenceId", "claimStatus", "metrics", "runs", "claims", "evidenceSha256"],
    "Public evidence",
  );
  assertRunArray(value.runs);
  const common = parseCommonHeader(value, 1);
  const metrics = parseMetrics(value.metrics);
  const runs = value.runs.map(parseRunV1);
  const parsed: PublicPilotEvidenceV1 = {
    schemaVersion: 1,
    kind: "launchrig-pilot-evidence",
    evidenceId: common.evidenceId,
    claimStatus: "self-recorded-unattested",
    metrics,
    runs,
    claims: common.claims,
    evidenceSha256: common.evidenceSha256,
  };
  assertV1MetricSemantics(metrics, runs);
  const { evidenceSha256, ...core } = parsed;
  if (sha256Value(core) !== evidenceSha256) throw new PilotError("Public evidence integrity check failed");
  return parsed;
}

function parsePublicEvidenceV2(value: Record<string, unknown>): PublicPilotEvidenceV2 {
  assertKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "evidenceId",
      "claimStatus",
      "metrics",
      "technicalPilot",
      "runs",
      "claims",
      "evidenceSha256",
    ],
    "Public evidence",
  );
  assertRunArray(value.runs);
  const common = parseCommonHeader(value, 2);
  const metrics = parseMetrics(value.metrics);
  const technicalPilot = parseTechnicalPilot(value.technicalPilot);
  const runs = value.runs.map(parseRunV2);
  assertSequentialOffsets(runs);
  if (sha256Value(metrics) !== sha256Value(metricsFromV2Runs(runs))) {
    throw new PilotError("Public evidence v2 metrics do not match the visible runs");
  }
  if (sha256Value(technicalPilot) !== sha256Value(technicalPilotFromV2Runs(runs))) {
    throw new PilotError("Public evidence v2 technical pilot does not match the visible runs");
  }
  const parsed: PublicPilotEvidenceV2 = {
    schemaVersion: 2,
    kind: "launchrig-pilot-evidence",
    evidenceId: common.evidenceId,
    claimStatus: "self-recorded-unattested",
    metrics,
    technicalPilot,
    runs,
    claims: common.claims,
    evidenceSha256: common.evidenceSha256,
  };
  const { evidenceSha256, ...core } = parsed;
  if (sha256Value(core) !== evidenceSha256) throw new PilotError("Public evidence integrity check failed");
  return parsed;
}

function parsePublicEvidence(value: unknown): PublicPilotEvidence {
  const evidence = assertRecord(value, "Public evidence");
  if (evidence.schemaVersion === 1) return parsePublicEvidenceV1(evidence);
  if (evidence.schemaVersion === 2) return parsePublicEvidenceV2(evidence);
  throw new PilotError("Public evidence schema identity is invalid");
}

async function readPublicEvidence(inputPath: string): Promise<unknown> {
  let handle;
  try {
    const before = await lstat(inputPath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size < 1n ||
      before.size > BigInt(MAX_PUBLIC_EVIDENCE_BYTES)
    ) {
      throw new Error("unsafe evidence file");
    }
    handle = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.size < 1n ||
      opened.size > BigInt(MAX_PUBLIC_EVIDENCE_BYTES) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs
    ) {
      throw new Error("unsafe evidence file");
    }
    const expectedSize = Number(opened.size);
    const buffer = Buffer.alloc(expectedSize + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      bytesRead !== expectedSize ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs
    ) {
      throw new Error("evidence changed while reading");
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, expectedSize));
    } catch {
      throw new PilotError("Public evidence must use valid UTF-8");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new PilotError("Public evidence must be strict JSON");
    }
    const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
    if (document.errors.length > 0) throw new PilotError("Public evidence must be strict JSON without duplicate keys");
    return parsed;
  } catch (error) {
    if (error instanceof PilotError) throw error;
    throw new PilotError("Public evidence file cannot be read safely", 3);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function verifyPublicPilotEvidence(inputPath: string): Promise<VerifiedPublicPilotEvidence> {
  const evidence = parsePublicEvidence(await readPublicEvidence(inputPath));
  if (evidence.schemaVersion === 1) {
    return {
      schemaVersion: 1,
      evidenceId: evidence.evidenceId,
      integrityValid: true,
      internalConsistencyValid: true,
      claimStatus: "self-recorded-unattested",
      metrics: evidence.metrics,
      technicalPilot: null,
      reportedTechnicalTargetsMet: false,
      grantReady: false,
      limitations: [...PUBLIC_EVIDENCE_V1_LIMITATIONS],
    };
  }
  return {
    schemaVersion: 2,
    evidenceId: evidence.evidenceId,
    integrityValid: true,
    internalConsistencyValid: true,
    claimStatus: "self-recorded-unattested",
    metrics: evidence.metrics,
    technicalPilot: evidence.technicalPilot,
    reportedTechnicalTargetsMet: evidence.technicalPilot.qualified,
    grantReady: false,
    limitations: [...PUBLIC_EVIDENCE_V2_LIMITATIONS],
  };
}
