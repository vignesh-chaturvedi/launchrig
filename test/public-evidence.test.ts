import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { verifyPublicPilotEvidence } from "../src/pilot/public-evidence.js";
import { sha256Value } from "../src/pilot/store.js";
import type { PublicPilotEvidenceV1 } from "../src/pilot/types.js";

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

function refreshDigest(evidence: PublicPilotEvidenceV1): void {
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
    assert.equal(verified.reportedTechnicalTargetsMet, true);
    assert.equal(verified.grantReady, false);
    assert.equal(verified.claimStatus, "self-recorded-unattested");
    assert.ok(verified.limitations.some((entry) => entry.includes("not a signature")));
    assert.ok(verified.limitations.some((entry) => entry.includes("cannot be independently recomputed")));
    assert.ok(verified.limitations.some((entry) => entry.includes("omits timestamps")));
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
