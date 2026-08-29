import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { verifyPublicPilotEvidence } from "../src/pilot/public-evidence.js";
import { sha256Value } from "../src/pilot/store.js";
import type {
  PublicPilotEvidenceV1,
  PublicPilotEvidenceV2,
  PublicPilotEvidenceV3,
} from "../src/pilot/types.js";

function validEvidence(): PublicPilotEvidenceV1 {
  const core: Omit<PublicPilotEvidenceV1, "evidenceSha256"> = {
    schemaVersion: 1,
    kind: "launchrig-pilot-evidence",
    evidenceId: "123e4567-e89b-42d3-a456-426614174000",
    claimStatus: "self-recorded-unattested",
    metrics: {
      runAttempts: 3,
      qualifyingRuns: 3,
      passRate: 1,
      consecutivePasses: 3,
      medianRunDurationMs: 5 * 60 * 1000,
      setupDurationMs: 20 * 60 * 1000,
      executionFingerprintSha256: "a".repeat(64),
      setupTargetMet: true,
      runtimeTargetMet: true,
      repeatabilityTargetMet: true,
    },
    runs: Array.from({ length: 3 }, (_, index) => ({
      runId: "run-" + String(index + 1).padStart(3, "0"),
      outcome: "passed" as const,
      readiness: "Android/MWA Ready" as const,
      durationMs: 5 * 60 * 1000,
      launchRigVersion: "0.1.0",
      physicalDevice: true,
      requiredChecksPassed: true,
      qualifying: true,
    })),
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

function validV2Evidence(): PublicPilotEvidenceV2 {
  const fingerprints = {
    device: "c".repeat(64),
    firstMwa: "a".repeat(64),
    currentMwa: "b".repeat(64),
  };
  const runs: PublicPilotEvidenceV2["runs"] = [
    {
      runId: "run-001",
      outcome: "passed",
      readiness: "Android Device Ready",
      durationMs: 60_000,
      elapsedSinceStartMs: 5 * 60_000,
      executionFingerprintSha256: fingerprints.device,
      launchRigVersion: "0.1.0",
      physicalDevice: true,
      requiredChecksPassed: true,
      qualifying: true,
    },
    {
      runId: "run-002",
      outcome: "passed",
      readiness: "Android/MWA Ready",
      durationMs: 8 * 60_000,
      elapsedSinceStartMs: 20 * 60_000,
      executionFingerprintSha256: fingerprints.firstMwa,
      launchRigVersion: "0.1.0",
      physicalDevice: true,
      requiredChecksPassed: true,
      qualifying: true,
    },
    ...[9, 7, 8].map((minutes, index) => ({
      runId: "run-" + String(index + 3).padStart(3, "0"),
      outcome: "passed" as const,
      readiness: "Android/MWA Ready" as const,
      durationMs: minutes * 60_000,
      elapsedSinceStartMs: ([31, 38, 46][index] ?? 0) * 60_000,
      executionFingerprintSha256: fingerprints.currentMwa,
      launchRigVersion: "0.1.0",
      physicalDevice: true,
      requiredChecksPassed: true,
      qualifying: true,
    })),
  ];
  const core: Omit<PublicPilotEvidenceV2, "evidenceSha256"> = {
    schemaVersion: 2,
    kind: "launchrig-pilot-evidence",
    evidenceId: "123e4567-e89b-42d3-a456-426614174000",
    claimStatus: "self-recorded-unattested",
    metrics: {
      runAttempts: 5,
      qualifyingRuns: 5,
      passRate: 1,
      consecutivePasses: 3,
      medianRunDurationMs: 8 * 60_000,
      setupDurationMs: 5 * 60_000,
      executionFingerprintSha256: fingerprints.currentMwa,
      setupTargetMet: true,
      runtimeTargetMet: true,
      repeatabilityTargetMet: true,
    },
    technicalPilot: {
      profile: "external-mwa-pilot-v1",
      qualified: true,
      latestReadiness: "Android/MWA Ready",
      trailingMwaPasses: 3,
      requiredTrailingMwaPasses: 3,
      setupDurationMs: 20 * 60_000,
      medianRunDurationMs: 8 * 60_000,
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

function validV3Evidence(): PublicPilotEvidenceV3 {
  const v2 = validV2Evidence();
  const scopeSha256 = "e".repeat(64);
  const { evidenceSha256: _legacyDigest, schemaVersion: _legacyVersion, runs: legacyRuns, ...shared } = v2;
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

function refreshDigest(
  evidence: PublicPilotEvidenceV1 | PublicPilotEvidenceV2 | PublicPilotEvidenceV3,
): void {
  const { evidenceSha256: _digest, ...core } = evidence;
  evidence.evidenceSha256 = sha256Value(core);
}

test("public evidence verifier is strict, offline, and explicit about its limitations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-public-evidence-"));
  try {
    const evidencePath = path.join(directory, "pilot-evidence.json");
    const evidence = validEvidence();
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");

    const verified = await verifyPublicPilotEvidence(evidencePath);
    assert.equal(verified.integrityValid, true);
    assert.equal(verified.internalConsistencyValid, true);
    assert.equal(verified.reportedTechnicalTargetsMet, false);
    assert.equal(verified.technicalPilot, null);
    assert.equal(verified.grantReady, false);
    assert.equal(verified.claimStatus, "self-recorded-unattested");
    assert.ok(verified.limitations.some((entry) => entry.includes("not a signature")));
    assert.ok(verified.limitations.some((entry) => entry.includes("cannot be independently recomputed")));
    assert.ok(verified.limitations.some((entry) => entry.includes("omits timestamps")));
    assert.ok(verified.limitations.some((entry) => entry.includes("strict external-MWA technical gate")));
    assert.ok(verified.limitations.some((entry) => entry.includes("self-recorded values")));

    const cliOutput: string[] = [];
    const cliErrors: string[] = [];
    assert.equal(
      await runCli(
        ["pilot", "verify", evidencePath, "--json"],
        { out: (message) => cliOutput.push(message), error: (message) => cliErrors.push(message) },
      ),
      0,
    );
    assert.equal(cliErrors.length, 0);
    const cliVerification = JSON.parse(cliOutput.join("\n")) as Record<string, unknown>;
    assert.equal(cliVerification.grantReady, false);
    assert.equal(cliVerification.claimStatus, "self-recorded-unattested");

    const unsupportedOptions = [
      ["--config", "other.yml"],
      ["--device", "TEST-DEVICE"],
      ["--scenario", "authorize"],
      ["--adb", "adb"],
      ["--maestro", "maestro"],
      ["--force"],
      ["--name", "other"],
      ["--package", "com.example.other"],
      ["--pilot", "other"],
      ["--repeat", "3"],
      ["--output", "other.json"],
    ];
    for (const option of unsupportedOptions) {
      const errors: string[] = [];
      assert.equal(
        await runCli(["pilot", "verify", evidencePath, ...option], {
          out: () => undefined,
          error: (message) => errors.push(message),
        }),
        2,
      );
      assert.ok(errors.some((message) => message.includes("does not accept")));
    }

    const reorderedPath = path.join(directory, "reordered.json");
    const { evidenceSha256, ...core } = evidence;
    await writeFile(
      reorderedPath,
      JSON.stringify({
        evidenceSha256,
        claims: core.claims,
        runs: core.runs,
        metrics: core.metrics,
        claimStatus: core.claimStatus,
        evidenceId: core.evidenceId,
        kind: core.kind,
        schemaVersion: core.schemaVersion,
      }) + "\n",
      "utf8",
    );
    assert.equal((await verifyPublicPilotEvidence(reorderedPath)).integrityValid, true);

    const impossibleMedian = structuredClone(evidence);
    impossibleMedian.metrics.medianRunDurationMs = 1;
    refreshDigest(impossibleMedian);
    await writeFile(evidencePath, JSON.stringify(impossibleMedian), "utf8");
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("median runtime is inconsistent"),
    );

    const missingVersion = structuredClone(evidence);
    delete missingVersion.runs[0]?.launchRigVersion;
    refreshDigest(missingVersion);
    await writeFile(evidencePath, JSON.stringify(missingVersion), "utf8");
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("must include a LaunchRig version"),
    );

    const tampered = structuredClone(evidence);
    const firstRun = tampered.runs[0];
    assert.ok(firstRun);
    firstRun.durationMs += 1;
    await writeFile(evidencePath, JSON.stringify(tampered), "utf8");
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("integrity check failed"),
    );

    const inconsistent = structuredClone(evidence);
    inconsistent.metrics.passRate = 0.5;
    refreshDigest(inconsistent);
    await writeFile(evidencePath, JSON.stringify(inconsistent), "utf8");
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("run metrics are inconsistent"),
    );

    const unknownField = structuredClone(evidence) as PublicPilotEvidenceV1 & {
      metrics: PublicPilotEvidenceV1["metrics"] & { publisherName?: string };
    };
    unknownField.metrics.publisherName = "private publisher";
    refreshDigest(unknownField);
    await writeFile(evidencePath, JSON.stringify(unknownField), "utf8");
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("unsupported fields"),
    );

    const validSource = JSON.stringify(evidence, null, 2);
    await writeFile(
      evidencePath,
      validSource.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,'),
      "utf8",
    );
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("duplicate keys"),
    );

    const symlinkPath = path.join(directory, "evidence-link.json");
    await writeFile(evidencePath, validSource, "utf8");
    await symlink(evidencePath, symlinkPath);
    await assert.rejects(
      () => verifyPublicPilotEvidence(symlinkPath),
      (error: unknown) => error instanceof Error && error.message.includes("cannot be read safely"),
    );
    const symlinkErrors: string[] = [];
    assert.equal(
      await runCli(["pilot", "verify", symlinkPath], {
        out: () => undefined,
        error: (message) => symlinkErrors.push(message),
      }),
      3,
    );
    assert.ok(symlinkErrors.some((message) => message.includes("cannot be read safely")));

    const evidenceDirectory = path.join(directory, "not-a-file");
    await mkdir(evidenceDirectory);
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidenceDirectory),
      (error: unknown) => error instanceof Error && error.message.includes("cannot be read safely"),
    );

    await writeFile(evidencePath, Buffer.from([0xff]));
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("valid UTF-8"),
    );

    await writeFile(evidencePath, Buffer.alloc(256 * 1024 + 1, 0x20));
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("cannot be read safely"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public evidence v2 recomputes the self-recorded technical gate without elevating external claims", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-public-evidence-v2-"));
  try {
    const evidencePath = path.join(directory, "pilot-evidence-v2.json");
    const evidence = validV2Evidence();
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");

    const verified = await verifyPublicPilotEvidence(evidencePath);
    assert.equal(verified.schemaVersion, 2);
    assert.equal(verified.reportedTechnicalTargetsMet, true);
    assert.equal(verified.technicalPilot?.qualified, true);
    assert.equal(verified.technicalPilot?.trailingMwaPasses, 3);
    assert.equal(verified.technicalPilot?.setupDurationMs, 20 * 60_000);
    assert.equal(verified.technicalPilot?.medianRunDurationMs, 8 * 60_000);
    assert.equal(verified.grantReady, false);
    assert.ok(verified.limitations.some((entry) => entry.includes("self-recorded fields")));
    assert.ok(verified.limitations.some((entry) => entry.includes("not established")));

    const humanOutput: string[] = [];
    assert.equal(
      await runCli(["pilot", "verify", evidencePath], {
        out: (message) => humanOutput.push(message),
        error: () => undefined,
      }),
      0,
    );
    assert.match(humanOutput.join("\n"), /evidence schema: v2/);
    assert.match(humanOutput.join("\n"), /technical pilot gate \(recomputed from self-recorded fields\): met/);
    assert.match(humanOutput.join("\n"), /external grant gate: not established/);
    assert.match(humanOutput.join("\n"), /grant ready: no/);

    const exactThresholds = structuredClone(evidence);
    exactThresholds.runs[1]!.elapsedSinceStartMs = 30 * 60_000;
    exactThresholds.runs[2]!.elapsedSinceStartMs = 40 * 60_000;
    exactThresholds.runs[3]!.elapsedSinceStartMs = 50 * 60_000;
    exactThresholds.runs[4]!.elapsedSinceStartMs = 60 * 60_000;
    for (const run of exactThresholds.runs.slice(2)) run.durationMs = 10 * 60_000;
    exactThresholds.metrics.medianRunDurationMs = 10 * 60_000;
    exactThresholds.technicalPilot.setupDurationMs = 30 * 60_000;
    exactThresholds.technicalPilot.medianRunDurationMs = 10 * 60_000;
    refreshDigest(exactThresholds);
    await writeFile(evidencePath, JSON.stringify(exactThresholds), "utf8");
    assert.equal((await verifyPublicPilotEvidence(evidencePath)).reportedTechnicalTargetsMet, true);

    const mismatchedTechnical = structuredClone(evidence);
    mismatchedTechnical.technicalPilot.qualified = false;
    refreshDigest(mismatchedTechnical);
    await writeFile(evidencePath, JSON.stringify(mismatchedTechnical), "utf8");
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("technical pilot does not match"),
    );

    const changedFingerprint = structuredClone(evidence);
    const finalRun = changedFingerprint.runs.at(-1);
    assert.ok(finalRun);
    finalRun.executionFingerprintSha256 = "d".repeat(64);
    refreshDigest(changedFingerprint);
    await writeFile(evidencePath, JSON.stringify(changedFingerprint), "utf8");
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("metrics do not match"),
    );

    const reversedOffset = structuredClone(evidence);
    const fourthRun = reversedOffset.runs[3];
    assert.ok(fourthRun);
    fourthRun.elapsedSinceStartMs = 1;
    refreshDigest(reversedOffset);
    await writeFile(evidencePath, JSON.stringify(reversedOffset), "utf8");
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("must be nondecreasing"),
    );

    const overlappingTimeline = structuredClone(evidence);
    const overlappingRun = overlappingTimeline.runs[2];
    assert.ok(overlappingRun);
    overlappingRun.elapsedSinceStartMs = 21 * 60_000;
    refreshDigest(overlappingTimeline);
    await writeFile(evidencePath, JSON.stringify(overlappingTimeline), "utf8");
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("cannot overlap sequential"),
    );

    const missingFingerprint = structuredClone(evidence);
    const firstRun = missingFingerprint.runs[0];
    assert.ok(firstRun);
    firstRun.executionFingerprintSha256 = null;
    refreshDigest(missingFingerprint);
    await writeFile(evidencePath, JSON.stringify(missingFingerprint), "utf8");
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("fingerprint is inconsistent"),
    );

    const elevatedClaim = structuredClone(evidence);
    (elevatedClaim.claims as unknown as Record<string, string>).externalPublisher = "established";
    refreshDigest(elevatedClaim);
    await writeFile(evidencePath, JSON.stringify(elevatedClaim), "utf8");
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("must remain not-established"),
    );

    const androidLatest = structuredClone(evidence);
    const androidRun = androidLatest.runs.at(-1);
    assert.ok(androidRun);
    androidRun.readiness = "Android Device Ready";
    androidLatest.technicalPilot = {
      profile: "external-mwa-pilot-v1",
      qualified: false,
      latestReadiness: "Android Device Ready",
      trailingMwaPasses: 0,
      requiredTrailingMwaPasses: 3,
      setupDurationMs: 20 * 60_000,
      medianRunDurationMs: null,
      setupTargetMet: true,
      runtimeTargetMet: false,
      repeatabilityTargetMet: false,
    };
    refreshDigest(androidLatest);
    await writeFile(evidencePath, JSON.stringify(androidLatest), "utf8");
    assert.equal((await verifyPublicPilotEvidence(evidencePath)).reportedTechnicalTargetsMet, false);

    const latestFailure = structuredClone(evidence);
    latestFailure.runs.push({
      runId: "run-006",
      outcome: "setup-error",
      readiness: "Not Ready",
      durationMs: 1_000,
      elapsedSinceStartMs: 47 * 60_000,
      executionFingerprintSha256: null,
      failureKind: "runner-error",
      physicalDevice: false,
      requiredChecksPassed: false,
      qualifying: false,
    });
    latestFailure.metrics = {
      runAttempts: 6,
      qualifyingRuns: 5,
      passRate: 5 / 6,
      consecutivePasses: 0,
      medianRunDurationMs: null,
      setupDurationMs: 5 * 60_000,
      executionFingerprintSha256: null,
      setupTargetMet: true,
      runtimeTargetMet: false,
      repeatabilityTargetMet: false,
    };
    latestFailure.technicalPilot = {
      profile: "external-mwa-pilot-v1",
      qualified: false,
      latestReadiness: "Not Ready",
      trailingMwaPasses: 0,
      requiredTrailingMwaPasses: 3,
      setupDurationMs: 20 * 60_000,
      medianRunDurationMs: null,
      setupTargetMet: true,
      runtimeTargetMet: false,
      repeatabilityTargetMet: false,
    };
    refreshDigest(latestFailure);
    await writeFile(evidencePath, JSON.stringify(latestFailure), "utf8");
    assert.equal((await verifyPublicPilotEvidence(evidencePath)).reportedTechnicalTargetsMet, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public evidence v3 recomputes scope linkage without authenticating external claims", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-public-evidence-v3-"));
  try {
    const evidencePath = path.join(directory, "pilot-evidence-v3.json");
    const evidence = validV3Evidence();
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");

    const verified = await verifyPublicPilotEvidence(evidencePath);
    assert.equal(verified.schemaVersion, 3);
    assert.equal(verified.sessionScopeSha256, evidence.sessionScope.scopeSha256);
    assert.equal(verified.reportedTechnicalTargetsMet, true);
    assert.equal(verified.grantReady, false);
    assert.ok(verified.limitations.some((entry) => entry.includes("does not authenticate consent")));
    assert.ok(verified.limitations.some((entry) => entry.includes("stable across reexports")));

    const human: string[] = [];
    assert.equal(
      await runCli(["pilot", "verify", evidencePath], {
        out: (message) => human.push(message),
        error: () => undefined,
      }),
      0,
    );
    assert.match(human.join("\n"), /evidence schema: v3/);
    assert.match(human.join("\n"), /technical pilot gate \(recomputed from self-recorded fields\): met/);
    assert.match(human.join("\n"), /grant ready: no/);

    const mismatchedScope = structuredClone(evidence);
    mismatchedScope.runs[0]!.sessionScopeSha256 = "f".repeat(64);
    refreshDigest(mismatchedScope);
    await writeFile(evidencePath, JSON.stringify(mismatchedScope), "utf8");
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("do not bind the declared session scope"),
    );

    const falseScopeMatch = structuredClone(evidence);
    falseScopeMatch.runs[0]!.scopeInputsMatched = false;
    refreshDigest(falseScopeMatch);
    await writeFile(evidencePath, JSON.stringify(falseScopeMatch), "utf8");
    await assert.rejects(
      () => verifyPublicPilotEvidence(evidencePath),
      (error: unknown) => error instanceof Error && error.message.includes("qualifying state is inconsistent"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
