import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { createPublicPilotEvidenceBinding } from "../src/pilot/binding.js";
import { createPilotSessionScopeReceipt } from "../src/pilot/session-scope.js";
import {
  auditPrivateCohortRegister,
  CohortRegisterError,
} from "../src/pilot/cohort-register.js";
import { sha256Value } from "../src/pilot/store.js";
import type {
  PublicPilotEvidenceV1,
  PublicPilotEvidenceV2,
  PublicPilotEvidenceV3,
} from "../src/pilot/types.js";

interface EvidenceFile {
  path: string;
  evidenceId: string;
  fileSha256: string;
  evidenceSha256: string;
  schemaVersion: 1 | 2 | 3;
}

interface EvidenceBinding {
  evidenceId: string;
  fileSha256: string;
  evidenceSha256: string;
  schemaVersion: 1 | 2 | 3;
}

const evidenceScopeById = new Map<string, string>();

function uuid(index: number): string {
  const hex = index.toString(16);
  return hex.padStart(8, "0") + "-0000-4000-a000-" + hex.padStart(12, "0");
}

function ref(kind: string, index: number): string {
  return "urn:launchrig:" + kind + ":" + uuid(index);
}

function digest(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function v2Evidence(index: number, runCount = 3): PublicPilotEvidenceV2 {
  const durationMs = 5 * 60_000;
  const setupDurationMs = 10 * 60_000;
  const fingerprint = digest("fingerprint-" + index);
  const runs: PublicPilotEvidenceV2["runs"] = Array.from({ length: runCount }, (_, runIndex) => ({
    runId: "run-" + String(runIndex + 1).padStart(3, "0"),
    outcome: "passed" as const,
    readiness: "Android/MWA Ready" as const,
    durationMs,
    elapsedSinceStartMs: setupDurationMs + runIndex * 6 * 60_000,
    executionFingerprintSha256: fingerprint,
    launchRigVersion: "0.1.0",
    physicalDevice: true,
    requiredChecksPassed: true,
    qualifying: true,
  }));
  const repeatabilityTargetMet = runCount >= 3;
  const core: Omit<PublicPilotEvidenceV2, "evidenceSha256"> = {
    schemaVersion: 2,
    kind: "launchrig-pilot-evidence",
    evidenceId: uuid(index),
    claimStatus: "self-recorded-unattested",
    metrics: {
      runAttempts: runCount,
      qualifyingRuns: runCount,
      passRate: 1,
      consecutivePasses: runCount,
      medianRunDurationMs: durationMs,
      setupDurationMs,
      executionFingerprintSha256: fingerprint,
      setupTargetMet: true,
      runtimeTargetMet: true,
      repeatabilityTargetMet,
    },
    technicalPilot: {
      profile: "external-mwa-pilot-v1",
      qualified: repeatabilityTargetMet,
      latestReadiness: "Android/MWA Ready",
      trailingMwaPasses: runCount,
      requiredTrailingMwaPasses: 3,
      setupDurationMs,
      medianRunDurationMs: durationMs,
      setupTargetMet: true,
      runtimeTargetMet: true,
      repeatabilityTargetMet,
    },
    runs,
    claims: {
      externalPublisher: "not-established",
      seekerHardware: "not-established",
      productionWallet: "not-established",
      seedVault: "not-established",
      confirmedDefect: "not-established",
    },
  };
  return { ...core, evidenceSha256: sha256Value(core) };
}

function v3Evidence(
  index: number,
  runCount = 3,
  scopeSha256 = digest("scope-" + index),
): PublicPilotEvidenceV3 {
  const legacy = v2Evidence(index, runCount);
  const { evidenceSha256: _legacyDigest, schemaVersion: _legacyVersion, runs: legacyRuns, ...shared } = legacy;
  const core: Omit<PublicPilotEvidenceV3, "evidenceSha256"> = {
    schemaVersion: 3,
    ...shared,
    sessionScope: {
      profile: "external-mwa-pilot-scope-v1",
      scopeSha256,
      claimStatus: "operator-prepared-unattested",
    },
    runs: legacyRuns.map((run) => ({
      ...run,
      sessionScopeSha256: scopeSha256,
      scopeInputsMatched: true,
    })),
  };
  return { ...core, evidenceSha256: sha256Value(core) };
}

function v1Evidence(index: number): PublicPilotEvidenceV1 {
  const durationMs = 5 * 60_000;
  const fingerprint = digest("legacy-fingerprint-" + index);
  const runs: PublicPilotEvidenceV1["runs"] = Array.from({ length: 3 }, (_, runIndex) => ({
    runId: "run-" + String(runIndex + 1).padStart(3, "0"),
    outcome: "passed" as const,
    readiness: "Android/MWA Ready" as const,
    durationMs,
    launchRigVersion: "0.1.0",
    physicalDevice: true,
    requiredChecksPassed: true,
    qualifying: true,
  }));
  const core: Omit<PublicPilotEvidenceV1, "evidenceSha256"> = {
    schemaVersion: 1,
    kind: "launchrig-pilot-evidence",
    evidenceId: uuid(index),
    claimStatus: "self-recorded-unattested",
    metrics: {
      runAttempts: 3,
      qualifyingRuns: 3,
      passRate: 1,
      consecutivePasses: 3,
      medianRunDurationMs: durationMs,
      setupDurationMs: 10 * 60_000,
      executionFingerprintSha256: fingerprint,
      setupTargetMet: true,
      runtimeTargetMet: true,
      repeatabilityTargetMet: true,
    },
    runs,
    claims: {
      externalPublisher: "not-established",
      seekerHardware: "not-established",
      productionWallet: "not-established",
      seedVault: "not-established",
      confirmedDefect: "not-established",
    },
  };
  return { ...core, evidenceSha256: sha256Value(core) };
}

async function writeEvidence(
  directory: string,
  index: number,
  evidence: PublicPilotEvidenceV1 | PublicPilotEvidenceV2 | PublicPilotEvidenceV3 = v3Evidence(index),
): Promise<EvidenceFile> {
  const target = path.join(directory, "evidence-" + index + ".json");
  const bytes = Buffer.from(JSON.stringify(evidence, null, 2) + "\n", "utf8");
  await writeFile(target, bytes);
  if (evidence.schemaVersion === 3) {
    evidenceScopeById.set(evidence.evidenceId, evidence.sessionScope.scopeSha256);
  }
  return {
    path: target,
    evidenceId: evidence.evidenceId,
    fileSha256: createHash("sha256").update(bytes).digest("hex"),
    evidenceSha256: evidence.evidenceSha256,
    schemaVersion: evidence.schemaVersion,
  };
}

function makeCandidate(index: number, evidence: EvidenceBinding | null) {
  const scopeSha256 = evidence
    ? (evidenceScopeById.get(evidence.evidenceId) ?? digest("scope-" + index))
    : digest("scope-" + index);
  return {
    candidateRef: ref("candidate", 100 + index),
    publisherRef: ref("publisher", 200 + index),
    projectRef: ref("project", 300 + index),
    lineageRef: ref("lineage", 400 + index),
    pilotRef: ref("pilot", 500 + index),
    recruitment: {
      status: "interest-recorded" as const,
      recordSha256: digest("recruitment-" + index),
      statusOn: "2026-08-01",
    },
    intakeReview: {
      status: "operator-recorded-sufficient" as const,
      recordSha256: digest("intake-" + index),
      reviewedOn: "2026-08-02",
      reviewerRef: ref("reviewer", 600 + index),
    },
    independenceReview: {
      status: "operator-recorded-eligible" as const,
      recordSha256: digest("independence-" + index),
      reviewedOn: "2026-08-03",
      reviewerRef: ref("reviewer", 700 + index),
      relationshipCodes: ["none-declared" as const],
    },
    consent: {
      status: "operator-recorded-active" as const,
      recordSha256: digest("consent-" + index),
      scopeSha256,
      effectiveOn: "2026-08-04",
      expiresOn: "2026-12-31",
      withdrawalRecordSha256: null,
      withdrawnOn: null,
    },
    session: {
      status: "completed" as const,
      statusOn: "2026-08-10",
      binding: {
        bundleId: "sha256:" + digest("bundle-" + index),
        packageSha256: digest("package-" + index),
        appBuildSha256: digest("app-build-" + index),
        walletArtifactSha256: digest("wallet-" + index),
        flowReviewSha256: digest("flow-review-" + index),
        scopeSha256,
      },
    },
    evidence: {
      sharingStatus: "operator-recorded-approved" as const,
      binding: evidence,
      decisionRecordSha256: digest("sharing-" + index),
      decidedOn: "2026-08-11",
      withdrawalRecordSha256: null,
      withdrawnOn: null,
    },
    closeout: {
      status: "operator-recorded-complete" as const,
      recordSha256: digest("closeout-" + index),
      completedOn: "2026-08-12",
    },
    countDecision: {
      status: "operator-recorded-include" as const,
      recordSha256: digest("count-" + index),
      reviewedOn: "2026-08-13",
      reviewerRef: ref("reviewer", 800 + index),
      reasonCodes: ["meets-recorded-policy" as const],
    },
  };
}

type Candidate = ReturnType<typeof makeCandidate>;

function makeDefect(index: number, candidates: readonly Candidate[]) {
  return {
    defectRef: ref("defect", 900 + index),
    status: "operator-recorded-cross-project-reproduction" as const,
    decisionRecordSha256: digest("defect-decision-" + index),
    reviewedOn: "2026-08-14",
    reviewerRef: ref("reviewer", 950 + index),
    reproductions: candidates.slice(0, 2).map((candidate, reproductionIndex) => ({
      candidateRef: candidate.candidateRef,
      defectRecordSha256: digest("defect-" + index + "-reproduction-" + reproductionIndex),
      sharingStatus: "operator-recorded-approved" as const,
      sharingDecisionRecordSha256: digest("defect-" + index + "-sharing-" + reproductionIndex),
    })),
  };
}

type Defect = ReturnType<typeof makeDefect>;

function makeRegisterCore(candidates: Candidate[], defects: Defect[] = []) {
  return {
    schemaVersion: 1 as const,
    kind: "launchrig-private-cohort-register" as const,
    profile: "phase-2c-publisher-governance-v1" as const,
    privacyProfile: "opaque-refs-digests-dates-v1" as const,
    registerRef: ref("register", 1),
    revision: 1,
    asOfDate: "2026-08-28",
    operatorRef: ref("operator", 1),
    candidates,
    defects,
  };
}

function sealedRegister(candidates: Candidate[], defects: Defect[] = []) {
  const core = makeRegisterCore(candidates, defects);
  return { ...core, integritySha256: sha256Value(core) };
}

async function writeRegister(
  directory: string,
  value: unknown,
  name = "private-cohort-register.json",
): Promise<string> {
  const target = path.join(directory, name);
  await writeFile(target, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600);
  return target;
}

function binding(evidence: EvidenceFile): EvidenceBinding {
  return {
    evidenceId: evidence.evidenceId,
    fileSha256: evidence.fileSha256,
    evidenceSha256: evidence.evidenceSha256,
    schemaVersion: evidence.schemaVersion,
  };
}

test("private cohort audit counts three scope-linked governed bindings without elevating external claims", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-register-qualified-"));
  try {
    const evidence = await Promise.all([1, 2, 3].map((index) => writeEvidence(directory, index)));
    const receiptBindings = await Promise.all(
      evidence.map(async (entry) => (await createPublicPilotEvidenceBinding(entry.path)).binding),
    );
    assert.deepEqual(receiptBindings, evidence.map((entry) => binding(entry)));
    const candidates = receiptBindings.map((entry, index) => makeCandidate(index + 1, entry));
    const registerPath = await writeRegister(directory, sealedRegister(candidates, [makeDefect(1, candidates)]));
    const output = await auditPrivateCohortRegister(registerPath, evidence.map((entry) => entry.path));

    assert.equal(output.register.integrityRecorded, true);
    assert.equal(output.summary.candidateRecords, 3);
    assert.equal(output.summary.matchedEvidenceBindings, 3);
    assert.equal(output.summary.recomputedQualifiedV2Bindings, 0);
    assert.equal(output.summary.recomputedQualifiedV3Bindings, 3);
    assert.equal(output.summary.recordedIncludedWithQualifiedV2, 0);
    assert.equal(output.summary.recordedIncludedWithScopeQualifiedV3, 3);
    assert.equal(output.summary.distinctRecordedPublishersForQualifiedIncluded, 3);
    assert.equal(output.summary.distinctRecordedProjectsForQualifiedIncluded, 3);
    assert.equal(output.summary.recordedGovernanceAndTechnicalThresholdMet, true);
    assert.ok(output.entries.every((entry) => entry.governanceStatus === "recorded-ready"));
    assert.ok(output.entries.every((entry) => entry.evidenceStatus === "matched-v3-scope-qualified"));
    assert.equal(output.defects[0]?.structuralStatus, "consistent");
    assert.equal(output.defects[0]?.qualifiedReproductionBindings, 2);
    assert.equal(output.externalGrantGate.status, "not-established");
    assert.equal(output.externalGrantGate.confirmedDefectAcrossTwoProjects, "not-established");
    assert.equal(output.grantReady, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session scope receipt binding feeds the private register without elevating consent claims", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-register-session-scope-"));
  try {
    const scopeInput = {
      schemaVersion: 1,
      kind: "launchrig-pilot-session-scope",
      profile: "external-mwa-pilot-scope-v1",
      scopeRef: ref("scope", 41),
      operatorRef: ref("operator", 41),
      pilotRef: ref("pilot", 41),
      deviceRef: ref("device", 41),
      bundle: {
        bundleId: "sha256:" + digest("scope-bundle-41"),
        manifestSha256: digest("scope-manifest-41"),
        sha256SumsSha256: digest("scope-sums-41"),
        packageSha256: digest("scope-package-41"),
      },
      inputs: {
        configSha256: digest("scope-config-41"),
        appBuildSha256: digest("scope-app-41"),
        walletArtifactSha256: digest("scope-wallet-41"),
        flows: [
          { kind: "mwa-reject", scenarioId: "reject", fileSha256: digest("scope-reject-41") },
          { kind: "mwa-siws", scenarioId: "siws", fileSha256: digest("scope-siws-41") },
          { kind: "mwa-authorize", scenarioId: "authorize", fileSha256: digest("scope-authorize-41") },
          { kind: "mwa-sign-message", scenarioId: "sign-message", fileSha256: digest("scope-sign-message-41") },
        ],
      },
      policy: {
        network: "devnet",
        walletMode: "mock-mwa",
        physicalAndroidRequired: true,
        attendedExecutionRequired: true,
        manualWalletActionsRequired: true,
        valuableAssetsAllowed: false,
        capture: { screenshots: "failure", includeLogcat: false, logcatLines: 200 },
        retention: { maxRuns: 5, expiresOn: "2026-12-31", deletionMethod: "standard-delete" },
        sharing: {
          publicEvidenceJson: true,
          sanitizedReports: false,
          publisherName: false,
          publisherLogo: false,
          approvedQuote: false,
          confirmedDefectRecord: false,
        },
      },
    };
    const scopePath = path.join(directory, "private-session-scope.json");
    await writeFile(scopePath, JSON.stringify(scopeInput, null, 2) + "\n", { mode: 0o600 });
    await chmod(scopePath, 0o600);
    const scopeReceipt = await createPilotSessionScopeReceipt(scopePath);
    const evidence = await writeEvidence(
      directory,
      41,
      v3Evidence(41, 3, scopeReceipt.binding.scopeSha256),
    );
    const evidenceBinding = (await createPublicPilotEvidenceBinding(evidence.path)).binding;
    const candidate = makeCandidate(41, evidenceBinding);
    candidate.consent.scopeSha256 = scopeReceipt.binding.scopeSha256;
    candidate.session.binding = scopeReceipt.binding;
    const registerPath = await writeRegister(directory, sealedRegister([candidate]));
    const output = await auditPrivateCohortRegister(registerPath, [evidence.path]);

    assert.equal(output.entries[0]?.governanceStatus, "recorded-ready");
    assert.equal(output.summary.recordedIncludedWithQualifiedV2, 0);
    assert.equal(output.summary.recordedIncludedWithScopeQualifiedV3, 1);
    assert.equal(output.externalGrantGate.status, "not-established");
    assert.equal(output.grantReady, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private cohort audit excludes incomplete, expired, withdrawn, legacy, and unqualified records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-register-exclusions-"));
  try {
    const qualified = await writeEvidence(directory, 11);
    const legacy = await writeEvidence(directory, 12, v1Evidence(12));
    const unqualified = await writeEvidence(directory, 13, v3Evidence(13, 2));
    const missing = makeCandidate(4, null) as any;
    missing.recruitment.status = "screening";
    missing.intakeReview.status = "needs-review";
    missing.independenceReview.status = "needs-review";
    missing.consent.status = "operator-recorded-expired";
    missing.consent.expiresOn = "2026-08-20";
    missing.session.status = "scheduled";
    missing.session.statusOn = "2026-09-01";
    missing.evidence.sharingStatus = "operator-recorded-withdrawn";
    missing.evidence.withdrawalRecordSha256 = digest("withdrawal-4");
    missing.evidence.withdrawnOn = "2026-08-20";
    missing.closeout.status = "pending";
    missing.countDecision.status = "operator-recorded-hold";
    missing.countDecision.reasonCodes = ["withdrawn"];
    const candidates = [
      makeCandidate(1, binding(qualified)),
      makeCandidate(2, binding(legacy)),
      makeCandidate(3, binding(unqualified)),
      missing,
    ];
    const registerPath = await writeRegister(directory, sealedRegister(candidates));
    const output = await auditPrivateCohortRegister(registerPath, [qualified.path, legacy.path, unqualified.path]);

    assert.deepEqual(
      output.entries.map((entry) => entry.evidenceStatus),
      ["matched-v3-scope-qualified", "matched-v1-not-recomputable", "matched-v3-not-qualified", "not-bound"],
    );
    assert.ok(output.entries[1]?.blockers.includes("evidence-v1-not-recomputable"));
    assert.ok(output.entries[2]?.blockers.includes("evidence-v3-not-qualified"));
    assert.ok(output.entries[3]?.blockers.includes("withdrawal-recorded"));
    assert.ok(output.entries[3]?.blockers.includes("consent-not-current"));
    assert.ok(output.entries[3]?.blockers.includes("lifecycle-date-inconsistent"));
    assert.equal(output.summary.recordedIncludedWithQualifiedV2, 0);
    assert.equal(output.summary.recordedIncludedWithScopeQualifiedV3, 1);
    assert.equal(output.summary.recordedGovernanceAndTechnicalThresholdMet, false);
    assert.equal(output.grantReady, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("qualified evidence v2 remains verifiable but cannot satisfy scope-linked governance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-register-unscoped-v2-"));
  try {
    const evidence = await writeEvidence(directory, 17, v2Evidence(17));
    const candidate = makeCandidate(17, binding(evidence));
    const registerPath = await writeRegister(directory, sealedRegister([candidate]));
    const output = await auditPrivateCohortRegister(registerPath, [evidence.path]);
    assert.equal(output.entries[0]?.governanceStatus, "recorded-ready");
    assert.equal(output.entries[0]?.evidenceStatus, "matched-v2-qualified");
    assert.ok(output.entries[0]?.blockers.includes("evidence-scope-unavailable"));
    assert.equal(output.summary.recomputedQualifiedV2Bindings, 1);
    assert.equal(output.summary.recordedIncludedWithQualifiedV2, 1);
    assert.equal(output.summary.recordedIncludedWithScopeQualifiedV3, 0);
    assert.equal(output.summary.recordedGovernanceAndTechnicalThresholdMet, false);
    assert.equal(output.grantReady, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private cohort audit rejects mismatched, duplicate, and unrepresented evidence inputs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-register-evidence-errors-"));
  try {
    const first = await writeEvidence(directory, 21);
    const extra = await writeEvidence(directory, 22);
    const validRegister = await writeRegister(directory, sealedRegister([makeCandidate(1, binding(first))]), "valid.json");

    await assert.rejects(
      () => auditPrivateCohortRegister(validRegister, [first.path, first.path]),
      (error: unknown) => error instanceof CohortRegisterError && error.message.includes("duplicates another"),
    );
    await assert.rejects(
      () => auditPrivateCohortRegister(validRegister, [extra.path]),
      (error: unknown) => error instanceof CohortRegisterError && error.message.includes("not represented"),
    );

    const wrongBinding = binding(first);
    wrongBinding.fileSha256 = digest("wrong-file-binding");
    const mismatchedRegister = await writeRegister(
      directory,
      sealedRegister([makeCandidate(2, wrongBinding)]),
      "mismatched.json",
    );
    await assert.rejects(
      () => auditPrivateCohortRegister(mismatchedRegister, [first.path]),
      (error: unknown) => error instanceof CohortRegisterError && error.message.includes("does not match"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private cohort register parser rejects unknown fields, duplicate keys, invalid values, and duplicate identities", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-register-strict-"));
  try {
    const evidence = await writeEvidence(directory, 31);
    const valid = sealedRegister([makeCandidate(1, binding(evidence))]);

    const unknown = { ...valid, privateNotes: "must never be accepted" };
    const unknownPath = await writeRegister(directory, unknown, "unknown.json");
    await assert.rejects(
      () => auditPrivateCohortRegister(unknownPath, []),
      (error: unknown) => error instanceof CohortRegisterError && error.message.includes("exact supported fields"),
    );

    const invalidRef = structuredClone(valid);
    invalidRef.candidates[0]!.publisherRef = "publisher@example.com";
    const invalidRefPath = await writeRegister(directory, invalidRef, "invalid-ref.json");
    await assert.rejects(
      () => auditPrivateCohortRegister(invalidRefPath, []),
      (error: unknown) => error instanceof CohortRegisterError && error.message.includes("reference is invalid"),
    );

    const invalidDate = structuredClone(valid);
    invalidDate.asOfDate = "2026-02-30";
    const invalidDatePath = await writeRegister(directory, invalidDate, "invalid-date.json");
    await assert.rejects(
      () => auditPrivateCohortRegister(invalidDatePath, []),
      (error: unknown) => error instanceof CohortRegisterError && error.message.includes("as-of date is invalid"),
    );

    const duplicateCandidate = structuredClone(valid);
    duplicateCandidate.candidates.push(structuredClone(duplicateCandidate.candidates[0]!));
    const duplicateCandidatePath = await writeRegister(directory, duplicateCandidate, "duplicate.json");
    await assert.rejects(
      () => auditPrivateCohortRegister(duplicateCandidatePath, []),
      (error: unknown) => error instanceof CohortRegisterError && error.message.includes("Candidate references must be unique"),
    );

    const tampered = structuredClone(valid);
    tampered.revision = 2;
    const tamperedPath = await writeRegister(directory, tampered, "tampered.json");
    await assert.rejects(
      () => auditPrivateCohortRegister(tamperedPath, []),
      (error: unknown) => error instanceof CohortRegisterError && error.message.includes("integrity check failed"),
    );

    const duplicateKeyPath = path.join(directory, "duplicate-key.json");
    await writeFile(duplicateKeyPath, '{"schemaVersion":1,"schemaVersion":1}\n', { mode: 0o600 });
    await chmod(duplicateKeyPath, 0o600);
    await assert.rejects(
      () => auditPrivateCohortRegister(duplicateKeyPath, []),
      (error: unknown) => error instanceof CohortRegisterError && error.message.includes("duplicate keys"),
    );

    const trackedExample = JSON.parse(
      await readFile(path.join(process.cwd(), "test", "fixtures", "cohort-register.example.json"), "utf8"),
    ) as unknown;
    const trackedExamplePath = await writeRegister(directory, trackedExample, "tracked-example.json");
    const trackedExampleAudit = await auditPrivateCohortRegister(trackedExamplePath, []);
    assert.equal(trackedExampleAudit.register.integrityRecorded, false);
    assert.equal(trackedExampleAudit.summary.candidateRecords, 0);
    assert.equal(trackedExampleAudit.grantReady, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private cohort audit blocks duplicate included publisher or project references", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-register-related-"));
  try {
    const evidence = await Promise.all([41, 42, 43].map((index) => writeEvidence(directory, index)));
    const candidates = evidence.map((entry, index) => makeCandidate(index + 1, binding(entry)));
    candidates[1]!.publisherRef = candidates[0]!.publisherRef;
    candidates[2]!.projectRef = candidates[0]!.projectRef;
    const registerPath = await writeRegister(directory, sealedRegister(candidates));
    const output = await auditPrivateCohortRegister(registerPath, evidence.map((entry) => entry.path));

    assert.ok(output.entries[0]?.blockers.includes("duplicate-included-publisher"));
    assert.ok(output.entries[0]?.blockers.includes("duplicate-included-project"));
    assert.ok(output.entries[1]?.blockers.includes("duplicate-included-publisher"));
    assert.ok(output.entries[2]?.blockers.includes("duplicate-included-project"));
    assert.equal(output.summary.recordedIncludedWithQualifiedV2, 0);
    assert.equal(output.summary.recordedGovernanceAndTechnicalThresholdMet, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private cohort reader rejects unsafe permissions, symlinks, hard links, directories, empty files, and invalid UTF-8", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-register-files-"));
  try {
    const register = sealedRegister([]);
    const unsafeMode = await writeRegister(directory, register, "unsafe-mode.json");
    await chmod(unsafeMode, 0o644);
    await assert.rejects(
      () => auditPrivateCohortRegister(unsafeMode, []),
      (error: unknown) => error instanceof CohortRegisterError && error.exitCode === 3,
    );

    const safe = await writeRegister(directory, register, "safe.json");
    const linked = path.join(directory, "linked.json");
    await symlink(safe, linked);
    await assert.rejects(
      () => auditPrivateCohortRegister(linked, []),
      (error: unknown) => error instanceof CohortRegisterError && error.exitCode === 3,
    );

    const hardlink = path.join(directory, "hardlink.json");
    await link(safe, hardlink);
    await assert.rejects(
      () => auditPrivateCohortRegister(safe, []),
      (error: unknown) => error instanceof CohortRegisterError && error.exitCode === 3,
    );

    const nestedDirectory = path.join(directory, "not-a-file");
    await mkdir(nestedDirectory);
    await assert.rejects(
      () => auditPrivateCohortRegister(nestedDirectory, []),
      (error: unknown) => error instanceof CohortRegisterError && error.exitCode === 3,
    );

    const empty = path.join(directory, "empty.json");
    await writeFile(empty, "", { mode: 0o600 });
    await assert.rejects(
      () => auditPrivateCohortRegister(empty, []),
      (error: unknown) => error instanceof CohortRegisterError && error.exitCode === 3,
    );

    const invalidUtf8 = path.join(directory, "invalid-utf8.json");
    await writeFile(invalidUtf8, Buffer.from([0xff, 0xfe, 0xfd]), { mode: 0o600 });
    await chmod(invalidUtf8, 0o600);
    await assert.rejects(
      () => auditPrivateCohortRegister(invalidUtf8, []),
      (error: unknown) => error instanceof CohortRegisterError && error.message.includes("valid UTF-8"),
    );

    const oversized = path.join(directory, "oversized.json");
    await writeFile(oversized, Buffer.alloc(512 * 1024 + 1, 0x20), { mode: 0o600 });
    await chmod(oversized, 0o600);
    await assert.rejects(
      () => auditPrivateCohortRegister(oversized, []),
      (error: unknown) => error instanceof CohortRegisterError && error.exitCode === 3,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private cohort integrity can be bootstrapped without turning the draft into a grant claim", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-register-bootstrap-"));
  try {
    const evidence = await Promise.all([51, 52, 53].map((index) => writeEvidence(directory, index)));
    const candidates = evidence.map((entry, index) => makeCandidate(index + 1, binding(entry)));
    const draft = { ...makeRegisterCore(candidates), integritySha256: null };
    const draftPath = await writeRegister(directory, draft, "draft.json");
    const draftOutput = await auditPrivateCohortRegister(draftPath, evidence.map((entry) => entry.path));
    assert.equal(draftOutput.register.integrityRecorded, false);
    assert.equal(draftOutput.summary.recordedIncludedWithQualifiedV2, 0);
    assert.equal(draftOutput.summary.recordedIncludedWithScopeQualifiedV3, 3);
    assert.equal(draftOutput.summary.recordedGovernanceAndTechnicalThresholdMet, false);
    assert.equal(draftOutput.grantReady, false);

    const sealed = { ...makeRegisterCore(candidates), integritySha256: draftOutput.register.contentSha256 };
    const sealedPath = await writeRegister(directory, sealed, "sealed.json");
    const sealedOutput = await auditPrivateCohortRegister(sealedPath, evidence.map((entry) => entry.path));
    assert.equal(sealedOutput.register.integrityRecorded, true);
    assert.equal(sealedOutput.summary.recordedGovernanceAndTechnicalThresholdMet, true);
    assert.equal(sealedOutput.externalGrantGate.status, "not-established");
    assert.equal(sealedOutput.grantReady, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cohort audit CLI renders privacy-limited human and JSON output and rejects unrelated options", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-register-cli-private-canary-"));
  try {
    const evidence = await Promise.all([61, 62, 63].map((index) => writeEvidence(directory, index)));
    const candidates = evidence.map((entry, index) => makeCandidate(index + 1, binding(entry)));
    const registerPath = await writeRegister(directory, sealedRegister(candidates));
    const evidencePaths = evidence.map((entry) => entry.path);

    const human: string[] = [];
    const humanErrors: string[] = [];
    assert.equal(
      await runCli(
        ["cohort", "audit", registerPath, ...evidencePaths],
        { out: (message) => human.push(message), error: (message) => humanErrors.push(message) },
      ),
      0,
    );
    const rendered = human.join("\n");
    assert.equal(humanErrors.length, 0);
    assert.match(rendered, /recorded governance and technical threshold: met/);
    assert.match(rendered, /publisher identity and authority: not established/);
    assert.match(rendered, /grant ready: no/);
    assert.doesNotMatch(rendered, /urn:launchrig:/);
    assert.doesNotMatch(rendered, /launchrig-register-cli-private-canary/);
    assert.doesNotMatch(rendered, new RegExp(digest("consent-1")));
    assert.doesNotMatch(rendered, new RegExp(evidence[0]!.fileSha256));

    const json: string[] = [];
    assert.equal(
      await runCli(
        ["cohort", "audit", registerPath, ...evidencePaths, "--json"],
        { out: (message) => json.push(message), error: () => undefined },
      ),
      0,
    );
    const parsed = JSON.parse(json.join("\n")) as { grantReady: boolean; externalGrantGate: { status: string } };
    assert.equal(parsed.grantReady, false);
    assert.equal(parsed.externalGrantGate.status, "not-established");
    assert.doesNotMatch(json.join("\n"), /urn:launchrig:/);
    assert.doesNotMatch(json.join("\n"), /launchrig-register-cli-private-canary/);
    assert.doesNotMatch(json.join("\n"), new RegExp(digest("consent-1")));
    assert.doesNotMatch(json.join("\n"), new RegExp(evidence[0]!.fileSha256));

    for (const args of [["--config", "other.yml"], ["--device", "PRIVATE-SERIAL"], ["--force"]]) {
      const errors: string[] = [];
      assert.equal(
        await runCli(["cohort", "audit", registerPath, ...args], {
          out: () => undefined,
          error: (message) => errors.push(message),
        }),
        2,
      );
      assert.ok(errors.some((message) => message.includes("does not accept")));
      assert.doesNotMatch(errors.join("\n"), /PRIVATE-SERIAL/);
    }

    const missingErrors: string[] = [];
    assert.equal(
      await runCli(["cohort", "audit"], {
        out: () => undefined,
        error: (message) => missingErrors.push(message),
      }),
      2,
    );
    assert.ok(missingErrors.some((message) => message.includes("requires a private register")));

    const before = await readFile(registerPath);
    await auditPrivateCohortRegister(registerPath, evidencePaths);
    assert.deepEqual(await readFile(registerPath), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
