import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { parseDocument } from "yaml";
import type { PilotMetricsV1, PublicPilotEvidenceV1 } from "./types.js";
import { PilotError, sha256Value } from "./store.js";

const MAX_PUBLIC_EVIDENCE_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SETUP_TARGET_MS = 30 * 60 * 1000;
const RUNTIME_TARGET_MS = 10 * 60 * 1000;

export const PUBLIC_EVIDENCE_LIMITATIONS = [
  "The integrity digest is not a signature or proof of publisher identity.",
  "Evidence v1 omits per-run fingerprints, so fingerprint-specific consecutive passes and median runtime cannot be independently recomputed.",
  "Evidence v1 omits timestamps, so setup duration cannot be independently recomputed.",
  "Evidence v1 cannot establish the strict external-MWA technical gate from its public fields.",
  "Physical-device and required-check flags are self-recorded values, not device attestations.",
  "Publisher independence, Seeker hardware, production wallets, Seed Vault, and confirmed defects remain not established.",
] as const;

export interface VerifiedPublicPilotEvidence {
  schemaVersion: 1;
  evidenceId: string;
  integrityValid: true;
  internalConsistencyValid: true;
  claimStatus: "self-recorded-unattested";
  metrics: PilotMetricsV1;
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

function parseRun(value: unknown, index: number): PublicPilotEvidenceV1["runs"][number] {
  const run = assertRecord(value, "Public evidence run");
  assertKeys(
    run,
    [
      "runId",
      "outcome",
      "readiness",
      "durationMs",
      "failureKind",
      "launchRigVersion",
      "physicalDevice",
      "requiredChecksPassed",
      "qualifying",
    ],
    "Public evidence run",
  );
  const expectedRunId = "run-" + String(index + 1).padStart(3, "0");
  if (run.runId !== expectedRunId) throw new PilotError("Public evidence run IDs must be sequential");
  const outcome = run.outcome;
  if (outcome !== "passed" && outcome !== "failed" && outcome !== "setup-error") {
    throw new PilotError("Public evidence run outcome is invalid");
  }
  const readiness = run.readiness;
  if (readiness !== "Android Device Ready" && readiness !== "Android/MWA Ready" && readiness !== "Not Ready") {
    throw new PilotError("Public evidence run readiness is invalid");
  }
  if ((outcome === "passed") === (readiness === "Not Ready")) {
    throw new PilotError("Public evidence run readiness is inconsistent");
  }
  const physicalDevice = requiredBoolean(run.physicalDevice, "Public evidence physicalDevice");
  const requiredChecksPassed = requiredBoolean(
    run.requiredChecksPassed,
    "Public evidence requiredChecksPassed",
  );
  const qualifying = requiredBoolean(run.qualifying, "Public evidence qualifying");
  if (qualifying !== (outcome === "passed" && physicalDevice && requiredChecksPassed)) {
    throw new PilotError("Public evidence qualifying state is inconsistent");
  }
  const parsed: PublicPilotEvidenceV1["runs"][number] = {
    runId: expectedRunId,
    outcome,
    readiness,
    durationMs: requiredInteger(run.durationMs, "Public evidence run durationMs", Number.MAX_SAFE_INTEGER),
    physicalDevice,
    requiredChecksPassed,
    qualifying,
  };
  if (run.failureKind !== undefined) {
    const failureKind = run.failureKind;
    if (failureKind !== "runner-error" && failureKind !== "input-mutation" && failureKind !== "report-invalid") {
      throw new PilotError("Public evidence failureKind is invalid");
    }
    if (outcome !== "setup-error" || readiness !== "Not Ready" || physicalDevice || requiredChecksPassed || qualifying) {
      throw new PilotError("Public evidence failed attempt is inconsistent");
    }
    parsed.failureKind = failureKind;
  }
  if (run.launchRigVersion !== undefined) {
    parsed.launchRigVersion = requiredString(run.launchRigVersion, "Public evidence LaunchRig version", 64);
  }
  if (run.failureKind === undefined && parsed.launchRigVersion === undefined) {
    throw new PilotError("Public evidence completed run must include a LaunchRig version");
  }
  return parsed;
}

function parseClaims(value: unknown): PublicPilotEvidenceV1["claims"] {
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

function assertMetricSemantics(metrics: PilotMetricsV1, runs: PublicPilotEvidenceV1["runs"]): void {
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
      const sorted = [...qualifyingDurations].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      const visibleMedian =
        sorted.length % 2 === 1
          ? (sorted[middle] as number)
          : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
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

function parsePublicEvidence(value: unknown): PublicPilotEvidenceV1 {
  const evidence = assertRecord(value, "Public evidence");
  assertKeys(
    evidence,
    ["schemaVersion", "kind", "evidenceId", "claimStatus", "metrics", "runs", "claims", "evidenceSha256"],
    "Public evidence",
  );
  if (evidence.schemaVersion !== 1 || evidence.kind !== "launchrig-pilot-evidence") {
    throw new PilotError("Public evidence schema identity is invalid");
  }
  const evidenceId = requiredString(evidence.evidenceId, "Public evidence ID", 36);
  if (!UUID_V4.test(evidenceId)) throw new PilotError("Public evidence ID must be a lowercase UUIDv4");
  if (evidence.claimStatus !== "self-recorded-unattested") {
    throw new PilotError("Public evidence claim status must remain self-recorded-unattested");
  }
  if (!Array.isArray(evidence.runs) || evidence.runs.length > 100) {
    throw new PilotError("Public evidence runs must be an array with at most 100 entries");
  }
  const metrics = parseMetrics(evidence.metrics);
  const runs = evidence.runs.map(parseRun);
  const parsed: PublicPilotEvidenceV1 = {
    schemaVersion: 1,
    kind: "launchrig-pilot-evidence",
    evidenceId,
    claimStatus: "self-recorded-unattested",
    metrics,
    runs,
    claims: parseClaims(evidence.claims),
    evidenceSha256: strictSha256(evidence.evidenceSha256, "Public evidence integrity digest"),
  };
  assertMetricSemantics(metrics, runs);
  const { evidenceSha256, ...core } = parsed;
  if (sha256Value(core) !== evidenceSha256) throw new PilotError("Public evidence integrity check failed");
  return parsed;
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
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new PilotError("Public evidence must be strict JSON");
    }
    const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
    if (document.errors.length > 0) throw new PilotError("Public evidence must be strict JSON without duplicate keys");
    return value;
  } catch (error) {
    if (error instanceof PilotError) throw error;
    throw new PilotError("Public evidence file cannot be read safely", 3);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function verifyPublicPilotEvidence(inputPath: string): Promise<VerifiedPublicPilotEvidence> {
  const evidence = parsePublicEvidence(await readPublicEvidence(inputPath));
  return {
    schemaVersion: 1,
    evidenceId: evidence.evidenceId,
    integrityValid: true,
    internalConsistencyValid: true,
    claimStatus: "self-recorded-unattested",
    metrics: evidence.metrics,
    reportedTechnicalTargetsMet: false,
    grantReady: false,
    limitations: [...PUBLIC_EVIDENCE_LIMITATIONS],
  };
}
