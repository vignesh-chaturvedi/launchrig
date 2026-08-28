import assert from "node:assert/strict";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { CohortError, verifyCohortEvidence } from "../src/pilot/cohort.js";
import { sha256Value } from "../src/pilot/store.js";
import type { PublicPilotEvidenceV1, PublicPilotEvidenceV2 } from "../src/pilot/types.js";

function evidenceId(index: number): string {
  return index.toString(16).padStart(8, "0") + "-0000-4000-a000-" + index.toString(16).padStart(12, "0");
}

function v2Evidence(index: number, runCount = 3): PublicPilotEvidenceV2 {
  const durationMs = 5 * 60_000;
  const setupDurationMs = 10 * 60_000;
  const fingerprint = index.toString(16).padStart(64, "0");
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
    evidenceId: evidenceId(index),
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

function v1Evidence(index: number): PublicPilotEvidenceV1 {
  const durationMs = 5 * 60_000;
  const fingerprint = index.toString(16).padStart(64, "0");
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
    evidenceId: evidenceId(index),
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

async function writeEvidence(directory: string, name: string, evidence: object): Promise<string> {
  const target = path.join(directory, name);
  await writeFile(target, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  return target;
}

test("cohort verifier aggregates three unique qualified evidence v2 files without elevating claims", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-cohort-qualified-"));
  try {
    const files = await Promise.all(
      [1, 2, 3].map((index) => writeEvidence(directory, "pilot-" + index + ".json", v2Evidence(index))),
    );
    const output = await verifyCohortEvidence(files);
    assert.equal(output.summary.submittedEvidenceFiles, 3);
    assert.equal(output.summary.uniqueEvidenceIds, 3);
    assert.equal(output.summary.recomputableV2Files, 3);
    assert.equal(output.summary.technicallyQualifiedFiles, 3);
    assert.equal(output.summary.selfRecordedTechnicalThresholdMet, true);
    assert.ok(output.evidence.every((entry) => entry.technicalStatus === "qualified"));
    assert.equal(output.externalGrantGate.status, "not-established");
    assert.equal(output.externalGrantGate.threeIndependentPublishers, "not-established");
    assert.equal(output.grantReady, false);
    assert.ok(output.limitations.some((entry) => entry.includes("do not prove distinct publishers")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cohort verifier keeps evidence v1 and incomplete v2 outside the technical threshold", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-cohort-partial-"));
  try {
    const files = [
      await writeEvidence(directory, "legacy.json", v1Evidence(4)),
      await writeEvidence(directory, "incomplete.json", v2Evidence(5, 2)),
      await writeEvidence(directory, "qualified.json", v2Evidence(6)),
    ];
    const output = await verifyCohortEvidence(files);
    assert.deepEqual(
      output.evidence.map((entry) => entry.technicalStatus),
      ["not-recomputable", "not-qualified", "qualified"],
    );
    assert.equal(output.summary.recomputableV2Files, 2);
    assert.equal(output.summary.technicallyQualifiedFiles, 1);
    assert.equal(output.summary.selfRecordedTechnicalThresholdMet, false);
    assert.equal(output.grantReady, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cohort verifier rejects duplicate evidence IDs and duplicate file identities", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-cohort-duplicates-"));
  try {
    const first = await writeEvidence(directory, "first.json", v2Evidence(7));
    const copied = await writeEvidence(directory, "copy.json", v2Evidence(7));
    await assert.rejects(
      () => verifyCohortEvidence([first, copied]),
      (error: unknown) => error instanceof CohortError && error.message.includes("evidence ID"),
    );

    const hardlink = path.join(directory, "hardlink.json");
    await link(first, hardlink);
    await assert.rejects(
      () => verifyCohortEvidence([first, hardlink]),
      (error: unknown) => error instanceof CohortError && error.message.includes("file identity"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cohort verifier rejects unsafe files and bounded input violations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-cohort-unsafe-"));
  try {
    const evidencePath = await writeEvidence(directory, "pilot.json", v2Evidence(8));
    const symlinkPath = path.join(directory, "pilot-link.json");
    await symlink(evidencePath, symlinkPath);
    await assert.rejects(
      () => verifyCohortEvidence([symlinkPath]),
      (error: unknown) => error instanceof CohortError && error.exitCode === 3,
    );
    await assert.rejects(
      () => verifyCohortEvidence([]),
      (error: unknown) => error instanceof CohortError && error.message.includes("1 to 25"),
    );
    await assert.rejects(
      () => verifyCohortEvidence(Array.from({ length: 26 }, () => evidencePath)),
      (error: unknown) => error instanceof CohortError && error.message.includes("1 to 25"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cohort verifier rejects a file changed around its verified read", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-cohort-mutation-"));
  try {
    const evidencePath = await writeEvidence(directory, "pilot.json", v2Evidence(9));
    await assert.rejects(
      () =>
        verifyCohortEvidence([evidencePath], async () => {
          await writeFile(evidencePath, JSON.stringify(v2Evidence(10)) + "\n", "utf8");
          return {
            schemaVersion: 2,
            evidenceId: evidenceId(9),
            integrityValid: true,
            internalConsistencyValid: true,
            claimStatus: "self-recorded-unattested",
            metrics: v2Evidence(9).metrics,
            technicalPilot: v2Evidence(9).technicalPilot,
            reportedTechnicalTargetsMet: true,
            grantReady: false,
            limitations: [],
          };
        }),
      (error: unknown) => error instanceof CohortError && error.message.includes("changed during"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cohort CLI renders claim-limited human and JSON output and rejects unrelated options", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-cohort-cli-"));
  try {
    const files = await Promise.all(
      [11, 12, 13].map((index) => writeEvidence(directory, "pilot-" + index + ".json", v2Evidence(index))),
    );
    const human: string[] = [];
    assert.equal(
      await runCli(["cohort", "verify", ...files], {
        out: (message) => human.push(message),
        error: () => undefined,
      }),
      0,
    );
    const rendered = human.join("\n");
    assert.match(rendered, /self-recorded technical threshold: met/);
    assert.match(rendered, /three independent publishers: not established/);
    assert.match(rendered, /grant ready: no/);

    const json: string[] = [];
    assert.equal(
      await runCli(["cohort", "verify", ...files, "--json"], {
        out: (message) => json.push(message),
        error: () => undefined,
      }),
      0,
    );
    const output = JSON.parse(json.join("\n")) as { grantReady: boolean; externalGrantGate: { status: string } };
    assert.equal(output.grantReady, false);
    assert.equal(output.externalGrantGate.status, "not-established");

    for (const option of [["--pilot", "publisher-01"], ["--config", "launchrig.yml"], ["--output", "gate.json"]]) {
      const errors: string[] = [];
      assert.equal(
        await runCli(["cohort", "verify", ...files, ...option], {
          out: () => undefined,
          error: (message) => errors.push(message),
        }),
        2,
      );
      assert.ok(errors.some((message) => message.includes("does not accept")));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
