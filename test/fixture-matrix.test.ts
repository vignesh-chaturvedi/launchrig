import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  FixtureMatrixValidationError,
  createFixtureMatrixRun,
  evaluateFixtureMatrix,
  parseFixtureMatrixManifest,
  parseFixtureMatrixRuns,
  type FixtureMatrixIssueCode,
  type FixtureMatrixManifestV1,
  type FixtureMatrixRun,
  type FixtureMatrixVariant,
} from "../src/fixtures/matrix.js";
import type { CheckResult, LaunchRigReport } from "../src/types.js";

const MATRIX_PATH = path.join(process.cwd(), "fixtures", "launchrig-matrix.v1.json");
const CASE_ID = "rejection-recovery";
const SCENARIO_ID = "rejection-recovery";
const TARGET_CHECK_ID = "scenario." + SCENARIO_ID;

async function loadManifest(): Promise<FixtureMatrixManifestV1> {
  return parseFixtureMatrixManifest(JSON.parse(await readFile(MATRIX_PATH, "utf8")) as unknown);
}

function runFor(variant: FixtureMatrixVariant): FixtureMatrixRun {
  const broken = variant === "broken";
  return {
    caseId: CASE_ID,
    variant,
    scenarioId: SCENARIO_ID,
    outcome: broken ? "failed" : "passed",
    exitCode: broken ? 1 : 0,
    checks: [
      { id: "tool.adb", status: "pass", required: true },
      { id: TARGET_CHECK_ID, status: broken ? "fail" : "pass", required: true },
    ],
  };
}

function validRuns(): FixtureMatrixRun[] {
  return [runFor("broken"), runFor("fixed")];
}

function cloneRuns(runs: readonly FixtureMatrixRun[]): FixtureMatrixRun[] {
  return structuredClone([...runs]);
}

function codesFor(runs: readonly FixtureMatrixRun[], manifest: FixtureMatrixManifestV1): FixtureMatrixIssueCode[] {
  return evaluateFixtureMatrix(manifest, runs).issues.map((entry) => entry.code);
}

function captureValidationIssues(callback: () => unknown): string[] {
  try {
    callback();
  } catch (error) {
    assert.ok(error instanceof FixtureMatrixValidationError);
    return error.issues;
  }
  assert.fail("Expected FixtureMatrixValidationError");
}

test("v1 fixture manifest has one executable rejection recovery pair", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.cases.length, 1);
  assert.deepEqual(manifest.cases[0], {
    id: CASE_ID,
    name: "Wallet rejection recovery",
    scenarioId: SCENARIO_ID,
    expectations: {
      broken: {
        launchUri: "launchrig://fixture/rejection?variant=broken",
        configSha256: "f0fa915ee548fde354956c1a4bf5b3dc49f54e68b203e0b806810f30253cdfd5",
        flowSha256: "dc50c55a9646ab917fefb32c6cafb7d5e99b4acec4f82971d72a0db00e0990d9",
        scenarioStatus: "fail",
        outcome: "failed",
        exitCode: 1,
      },
      fixed: {
        launchUri: "launchrig://fixture/rejection?variant=fixed",
        configSha256: "d5db65006080f544dd7f7399e96411170b3b9d29576985a0f7c7f47133b66d42",
        flowSha256: "e120f0866fa3e634a5c6798e0941bcfdeaa55b61adfc45d46f1cf8d38d9cd49f",
        scenarioStatus: "pass",
        outcome: "passed",
        exitCode: 0,
      },
    },
  });
});

test("accepts only the expected red and green pair without changing the broken outcome", async () => {
  const manifest = await loadManifest();
  const runs = validRuns().reverse();
  const before = structuredClone(runs);
  const evaluation = evaluateFixtureMatrix(manifest, runs);

  assert.equal(evaluation.accepted, true);
  assert.deepEqual(evaluation.issues, []);
  assert.equal(evaluation.cases[0]?.accepted, true);
  assert.equal(evaluation.cases[0]?.broken.accepted, true);
  assert.equal(evaluation.cases[0]?.broken.outcome, "failed");
  assert.equal(evaluation.cases[0]?.broken.exitCode, 1);
  assert.equal(evaluation.cases[0]?.fixed.outcome, "passed");
  assert.equal(evaluation.cases[0]?.fixed.exitCode, 0);
  assert.deepEqual(runs, before);
});

test("createFixtureMatrixRun keeps the report outcome and projects only gate fields", () => {
  const checks: CheckResult[] = [
    {
      id: TARGET_CHECK_ID,
      name: "Reject and recover",
      status: "fail",
      required: true,
      durationMs: 25,
      summary: "The injected rejection bug was detected",
      details: "fixture detail",
    },
  ];
  const report: Pick<LaunchRigReport, "outcome" | "checks"> = { outcome: "failed", checks };
  const run = createFixtureMatrixRun({
    caseId: CASE_ID,
    variant: "broken",
    scenarioId: SCENARIO_ID,
    exitCode: 1,
    report,
  });

  assert.equal(run.outcome, "failed");
  assert.deepEqual(run.checks, [{ id: TARGET_CHECK_ID, status: "fail", required: true }]);
  assert.equal(checks[0]?.details, "fixture detail");
});

test("rejects setup errors even when the target failure is present", async () => {
  const manifest = await loadManifest();
  const runs = validRuns();
  const broken = runs[0];
  assert.ok(broken);
  broken.outcome = "setup-error";
  broken.exitCode = 3;
  broken.checks.unshift({ id: "device.connected", status: "fail", required: true });

  const evaluation = evaluateFixtureMatrix(manifest, runs);
  assert.equal(evaluation.accepted, false);
  assert.ok(codesFor(runs, manifest).includes("setup-error"));
  assert.ok(codesFor(runs, manifest).includes("unrelated-required-failure"));
});

test("rejects every outcome, exit, and target status contract mismatch", async (context) => {
  const manifest = await loadManifest();
  const cases: Array<{
    name: string;
    mutate: (runs: FixtureMatrixRun[]) => void;
    code: FixtureMatrixIssueCode;
  }> = [
    {
      name: "broken target passes",
      mutate: (runs) => {
        const target = runs[0]?.checks.find((check) => check.id === TARGET_CHECK_ID);
        if (target) target.status = "pass";
      },
      code: "target-status-mismatch",
    },
    {
      name: "broken outcome passes",
      mutate: (runs) => {
        const run = runs[0];
        if (run) run.outcome = "passed";
      },
      code: "outcome-mismatch",
    },
    {
      name: "broken exit is zero",
      mutate: (runs) => {
        const run = runs[0];
        if (run) run.exitCode = 0;
      },
      code: "exit-code-mismatch",
    },
    {
      name: "fixed target fails",
      mutate: (runs) => {
        const target = runs[1]?.checks.find((check) => check.id === TARGET_CHECK_ID);
        if (target) target.status = "fail";
      },
      code: "target-status-mismatch",
    },
    {
      name: "fixed outcome fails",
      mutate: (runs) => {
        const run = runs[1];
        if (run) run.outcome = "failed";
      },
      code: "outcome-mismatch",
    },
    {
      name: "fixed exit is one",
      mutate: (runs) => {
        const run = runs[1];
        if (run) run.exitCode = 1;
      },
      code: "exit-code-mismatch",
    },
  ];

  for (const entry of cases) {
    await context.test(entry.name, () => {
      const runs = validRuns();
      entry.mutate(runs);
      const evaluation = evaluateFixtureMatrix(manifest, runs);
      assert.equal(evaluation.accepted, false);
      assert.ok(evaluation.issues.some((matrixIssue) => matrixIssue.code === entry.code));
    });
  }
});

test("allows optional unrelated failures but rejects required unrelated failures", async () => {
  const manifest = await loadManifest();
  const optionalFailureRuns = validRuns();
  optionalFailureRuns[0]?.checks.push({ id: "diagnostic.optional", status: "fail", required: false });
  assert.equal(evaluateFixtureMatrix(manifest, optionalFailureRuns).accepted, true);

  const requiredFailureRuns = validRuns();
  requiredFailureRuns[0]?.checks.push({ id: "app.installed", status: "fail", required: true });
  const evaluation = evaluateFixtureMatrix(manifest, requiredFailureRuns);
  assert.equal(evaluation.accepted, false);
  assert.ok(evaluation.issues.some((entry) => entry.code === "unrelated-required-failure"));
});

test("rejects unrelated required checks that warn or skip", async (context) => {
  const manifest = await loadManifest();

  for (const status of ["warn", "skip"] as const) {
    await context.test("required " + status, () => {
      const runs = validRuns();
      runs[0]?.checks.push({ id: "diagnostic." + status, status, required: true });

      const evaluation = evaluateFixtureMatrix(manifest, runs);
      assert.equal(evaluation.accepted, false);
      assert.ok(
        evaluation.issues.some(
          (entry) =>
            entry.code === "unrelated-required-failure" && entry.message.includes("diagnostic." + status),
        ),
      );
    });
  }
});

test("rejects missing, duplicate, unexpected, and wrong matrix runs", async () => {
  const manifest = await loadManifest();

  const missing = evaluateFixtureMatrix(manifest, [runFor("broken")]);
  assert.equal(missing.accepted, false);
  assert.ok(missing.issues.some((entry) => entry.code === "missing-run" && entry.variant === "fixed"));

  const duplicateRuns = validRuns();
  duplicateRuns.push(runFor("broken"));
  const duplicate = evaluateFixtureMatrix(manifest, duplicateRuns);
  assert.equal(duplicate.accepted, false);
  assert.ok(duplicate.issues.some((entry) => entry.code === "duplicate-run"));

  const unexpectedRuns = validRuns();
  unexpectedRuns.push({ ...runFor("fixed"), caseId: "not-in-manifest" });
  const unexpected = evaluateFixtureMatrix(manifest, unexpectedRuns);
  assert.equal(unexpected.accepted, false);
  assert.ok(unexpected.issues.some((entry) => entry.code === "unexpected-run"));

  const wrongScenarioRuns = validRuns();
  const wrongScenario = wrongScenarioRuns[0];
  assert.ok(wrongScenario);
  wrongScenario.scenarioId = "another-scenario";
  const wrong = evaluateFixtureMatrix(manifest, wrongScenarioRuns);
  assert.equal(wrong.accepted, false);
  assert.ok(wrong.issues.some((entry) => entry.code === "scenario-mismatch"));

  const missingTargetRuns = validRuns();
  const missingTarget = missingTargetRuns[0];
  assert.ok(missingTarget);
  missingTarget.checks = missingTarget.checks.filter((check) => check.id !== TARGET_CHECK_ID);
  const noTarget = evaluateFixtureMatrix(manifest, missingTargetRuns);
  assert.equal(noTarget.accepted, false);
  assert.ok(noTarget.issues.some((entry) => entry.code === "missing-target-check"));
});

test("requires the target scenario check to be required", async () => {
  const manifest = await loadManifest();
  const runs = validRuns();
  const target = runs[0]?.checks.find((check) => check.id === TARGET_CHECK_ID);
  assert.ok(target);
  target.required = false;
  const evaluation = evaluateFixtureMatrix(manifest, runs);
  assert.equal(evaluation.accepted, false);
  assert.ok(evaluation.issues.some((entry) => entry.code === "target-not-required"));
});

test("manifest parser rejects missing and duplicate case identifiers and mutable expectations", async () => {
  const manifest = await loadManifest();

  const missingId = structuredClone(manifest) as unknown as {
    schemaVersion: number;
    cases: Array<Record<string, unknown>>;
  };
  delete missingId.cases[0]?.id;
  assert.ok(captureValidationIssues(() => parseFixtureMatrixManifest(missingId)).some((entry) => entry.includes(".id")));

  const duplicateId = { ...manifest, cases: [...manifest.cases, structuredClone(manifest.cases[0])] };
  assert.ok(
    captureValidationIssues(() => parseFixtureMatrixManifest(duplicateId)).some((entry) => entry.includes("duplicates")),
  );

  const weakened = structuredClone(manifest);
  const broken = weakened.cases[0]?.expectations.broken as { outcome: string } | undefined;
  if (broken) broken.outcome = "passed";
  assert.ok(
    captureValidationIssues(() => parseFixtureMatrixManifest(weakened)).some((entry) =>
      entry.includes("outcome must be failed"),
    ),
  );

  const malformedHash = structuredClone(manifest);
  malformedHash.cases[0]!.expectations.fixed.flowSha256 = "not-a-digest";
  assert.ok(
    captureValidationIssues(() => parseFixtureMatrixManifest(malformedHash)).some((entry) =>
      entry.includes("flowSha256 must be 64 lowercase hexadecimal characters"),
    ),
  );

  const unknownKey = { ...manifest, allowSetupErrors: true };
  assert.ok(
    captureValidationIssues(() => parseFixtureMatrixManifest(unknownKey)).some((entry) =>
      entry.includes("allowSetupErrors is not supported"),
    ),
  );
});

test("run parser is strict and rejects missing or duplicate case identifiers", () => {
  const runs = validRuns();
  assert.deepEqual(parseFixtureMatrixRuns(JSON.parse(JSON.stringify(runs)) as unknown), runs);

  const missingCaseId = { ...runFor("broken"), caseId: "" };
  assert.ok(
    captureValidationIssues(() => parseFixtureMatrixRuns([missingCaseId])).some((entry) => entry.includes("caseId")),
  );

  assert.ok(
    captureValidationIssues(() => parseFixtureMatrixRuns([runFor("broken"), runFor("broken")])).some((entry) =>
      entry.includes("duplicates case"),
    ),
  );

  const duplicateCheck = runFor("broken");
  duplicateCheck.checks.push({ id: TARGET_CHECK_ID, status: "fail", required: true });
  assert.ok(
    captureValidationIssues(() => parseFixtureMatrixRuns([duplicateCheck])).some((entry) =>
      entry.includes("duplicates " + TARGET_CHECK_ID),
    ),
  );

  const unknownKey = { ...runFor("fixed"), reportPath: "/tmp/report.json" };
  assert.ok(
    captureValidationIssues(() => parseFixtureMatrixRuns([unknownKey])).some((entry) =>
      entry.includes("reportPath is not supported"),
    ),
  );
});

test("evaluation diagnostics are deterministic regardless of input order", async () => {
  const manifest = await loadManifest();
  const runs = validRuns();
  runs.push({ ...runFor("fixed"), caseId: "z-case" });
  runs.push({ ...runFor("broken"), caseId: "a-case" });

  const forward = evaluateFixtureMatrix(manifest, cloneRuns(runs));
  const reverse = evaluateFixtureMatrix(manifest, cloneRuns(runs).reverse());
  assert.deepEqual(reverse, forward);
});
