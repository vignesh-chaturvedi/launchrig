import type { CheckResult, LaunchRigReport } from "../types.js";

export const FIXTURE_MATRIX_SCHEMA_VERSION = 1 as const;

export type FixtureMatrixVariant = "broken" | "fixed";

export interface BrokenFixtureMatrixExpectation {
  launchUri: string;
  configSha256: string;
  flowSha256: string;
  scenarioStatus: "fail";
  outcome: "failed";
  exitCode: 1;
}

export interface FixedFixtureMatrixExpectation {
  launchUri: string;
  configSha256: string;
  flowSha256: string;
  scenarioStatus: "pass";
  outcome: "passed";
  exitCode: 0;
}

export interface FixtureMatrixCaseV1 {
  id: string;
  name: string;
  scenarioId: string;
  expectations: {
    broken: BrokenFixtureMatrixExpectation;
    fixed: FixedFixtureMatrixExpectation;
  };
}

export interface FixtureMatrixManifestV1 {
  schemaVersion: typeof FIXTURE_MATRIX_SCHEMA_VERSION;
  cases: FixtureMatrixCaseV1[];
}

export type FixtureMatrixCheck = Pick<CheckResult, "id" | "status" | "required">;

export interface FixtureMatrixRun {
  caseId: string;
  variant: FixtureMatrixVariant;
  scenarioId: string;
  outcome: LaunchRigReport["outcome"];
  exitCode: number;
  checks: FixtureMatrixCheck[];
}

export type FixtureMatrixIssueCode =
  | "duplicate-run"
  | "duplicate-target-check"
  | "exit-code-mismatch"
  | "missing-run"
  | "missing-target-check"
  | "outcome-mismatch"
  | "scenario-mismatch"
  | "setup-error"
  | "target-not-required"
  | "target-status-mismatch"
  | "unexpected-run"
  | "unrelated-required-failure";

export interface FixtureMatrixIssue {
  code: FixtureMatrixIssueCode;
  caseId: string;
  variant: FixtureMatrixVariant | null;
  message: string;
}

export interface FixtureMatrixVariantEvaluation {
  variant: FixtureMatrixVariant;
  accepted: boolean;
  outcome: LaunchRigReport["outcome"] | null;
  exitCode: number | null;
  issues: FixtureMatrixIssue[];
}

export interface FixtureMatrixCaseEvaluation {
  id: string;
  scenarioId: string;
  accepted: boolean;
  broken: FixtureMatrixVariantEvaluation;
  fixed: FixtureMatrixVariantEvaluation;
}

export interface FixtureMatrixEvaluation {
  accepted: boolean;
  cases: FixtureMatrixCaseEvaluation[];
  issues: FixtureMatrixIssue[];
}

export class FixtureMatrixValidationError extends Error {
  readonly issues: string[];

  constructor(issues: readonly string[]) {
    super("LaunchRig fixture matrix data is invalid");
    this.name = "FixtureMatrixValidationError";
    this.issues = [...issues];
  }
}

const VARIANTS: readonly FixtureMatrixVariant[] = ["broken", "fixed"];
const CHECK_STATUSES: readonly CheckResult["status"][] = ["pass", "fail", "warn", "skip"];
const OUTCOMES: readonly LaunchRigReport["outcome"][] = ["passed", "failed", "setup-error"];
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const EXPECTED_CONTRACT = {
  broken: {
    scenarioStatus: "fail",
    outcome: "failed",
    exitCode: 1,
  },
  fixed: {
    scenarioStatus: "pass",
    outcome: "passed",
    exitCode: 0,
  },
} as const satisfies Record<
  FixtureMatrixVariant,
  Pick<BrokenFixtureMatrixExpectation | FixedFixtureMatrixExpectation, "scenarioStatus" | "outcome" | "exitCode">
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, path: string, issues: string[]): Record<string, unknown> {
  if (!isRecord(value)) {
    issues.push(path + " must be an object");
    return {};
  }
  return value;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(record).sort()) {
    if (!allowed.includes(key)) issues.push(path + "." + key + " is not supported");
  }
}

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(path + "." + key + " must be a non-empty string");
    return "";
  }
  return value.trim();
}

function readId(record: Record<string, unknown>, key: string, path: string, issues: string[]): string {
  const value = readNonEmptyString(record, key, path, issues);
  if (value && !ID_PATTERN.test(value)) {
    issues.push(path + "." + key + " must contain lowercase letters, numbers, or hyphens");
  }
  return value;
}

function readSha256(record: Record<string, unknown>, key: string, path: string, issues: string[]): string {
  const value = readNonEmptyString(record, key, path, issues);
  if (value && !SHA256_PATTERN.test(value)) {
    issues.push(path + "." + key + " must be 64 lowercase hexadecimal characters");
  }
  return value;
}

function validateLaunchUri(value: string, variant: FixtureMatrixVariant, path: string, issues: string[]): void {
  if (!value) return;
  try {
    const uri = new URL(value);
    if (!uri.protocol || uri.searchParams.get("variant") !== variant) {
      issues.push(path + " must include variant=" + variant);
    }
  } catch {
    issues.push(path + " must be an absolute URI");
  }
}

function parseExpectation(
  value: unknown,
  variant: "broken",
  path: string,
  issues: string[],
): BrokenFixtureMatrixExpectation;
function parseExpectation(
  value: unknown,
  variant: "fixed",
  path: string,
  issues: string[],
): FixedFixtureMatrixExpectation;
function parseExpectation(
  value: unknown,
  variant: FixtureMatrixVariant,
  path: string,
  issues: string[],
): BrokenFixtureMatrixExpectation | FixedFixtureMatrixExpectation {
  const record = readRecord(value, path, issues);
  rejectUnknownKeys(
    record,
    ["launchUri", "configSha256", "flowSha256", "scenarioStatus", "outcome", "exitCode"],
    path,
    issues,
  );
  const launchUri = readNonEmptyString(record, "launchUri", path, issues);
  const configSha256 = readSha256(record, "configSha256", path, issues);
  const flowSha256 = readSha256(record, "flowSha256", path, issues);
  validateLaunchUri(launchUri, variant, path + ".launchUri", issues);
  const expected = EXPECTED_CONTRACT[variant];
  if (record.scenarioStatus !== expected.scenarioStatus) {
    issues.push(path + ".scenarioStatus must be " + expected.scenarioStatus);
  }
  if (record.outcome !== expected.outcome) {
    issues.push(path + ".outcome must be " + expected.outcome);
  }
  if (record.exitCode !== expected.exitCode) {
    issues.push(path + ".exitCode must be " + expected.exitCode);
  }
  return { launchUri, configSha256, flowSha256, ...expected };
}

function parseManifestCases(value: unknown, issues: string[]): FixtureMatrixCaseV1[] {
  if (!Array.isArray(value)) {
    issues.push("matrix.cases must be an array");
    return [];
  }
  if (value.length === 0) issues.push("matrix.cases must contain at least one case");

  const seenCaseIds = new Set<string>();
  const seenScenarioIds = new Set<string>();
  return value.map((entry, index) => {
    const path = "matrix.cases[" + index + "]";
    const record = readRecord(entry, path, issues);
    rejectUnknownKeys(record, ["id", "name", "scenarioId", "expectations"], path, issues);
    const id = readId(record, "id", path, issues);
    const name = readNonEmptyString(record, "name", path, issues);
    const scenarioId = readId(record, "scenarioId", path, issues);

    if (id && seenCaseIds.has(id)) issues.push(path + ".id duplicates " + id);
    if (id) seenCaseIds.add(id);
    if (scenarioId && seenScenarioIds.has(scenarioId)) {
      issues.push(path + ".scenarioId duplicates " + scenarioId);
    }
    if (scenarioId) seenScenarioIds.add(scenarioId);

    const expectationsPath = path + ".expectations";
    const expectations = readRecord(record.expectations, expectationsPath, issues);
    rejectUnknownKeys(expectations, VARIANTS, expectationsPath, issues);
    return {
      id,
      name,
      scenarioId,
      expectations: {
        broken: parseExpectation(expectations.broken, "broken", expectationsPath + ".broken", issues),
        fixed: parseExpectation(expectations.fixed, "fixed", expectationsPath + ".fixed", issues),
      },
    };
  });
}

export function parseFixtureMatrixManifest(value: unknown): FixtureMatrixManifestV1 {
  const issues: string[] = [];
  const root = readRecord(value, "matrix", issues);
  rejectUnknownKeys(root, ["schemaVersion", "cases"], "matrix", issues);
  if (root.schemaVersion !== FIXTURE_MATRIX_SCHEMA_VERSION) {
    issues.push("matrix.schemaVersion must be " + FIXTURE_MATRIX_SCHEMA_VERSION);
  }
  const cases = parseManifestCases(root.cases, issues);
  if (issues.length > 0) throw new FixtureMatrixValidationError(issues);
  return { schemaVersion: FIXTURE_MATRIX_SCHEMA_VERSION, cases };
}

function parseRunCheck(value: unknown, path: string, issues: string[]): FixtureMatrixCheck {
  const record = readRecord(value, path, issues);
  rejectUnknownKeys(record, ["id", "status", "required"], path, issues);
  const id = readNonEmptyString(record, "id", path, issues);
  const status = record.status;
  if (!CHECK_STATUSES.includes(status as CheckResult["status"])) {
    issues.push(path + ".status must be pass, fail, warn, or skip");
  }
  if (typeof record.required !== "boolean") issues.push(path + ".required must be true or false");
  return {
    id,
    status: CHECK_STATUSES.includes(status as CheckResult["status"])
      ? (status as CheckResult["status"])
      : "fail",
    required: typeof record.required === "boolean" ? record.required : false,
  };
}

function parseRun(value: unknown, index: number, issues: string[]): FixtureMatrixRun {
  const path = "runs[" + index + "]";
  const record = readRecord(value, path, issues);
  rejectUnknownKeys(record, ["caseId", "variant", "scenarioId", "outcome", "exitCode", "checks"], path, issues);
  const caseId = readId(record, "caseId", path, issues);
  const scenarioId = readId(record, "scenarioId", path, issues);
  const variant = record.variant;
  if (variant !== "broken" && variant !== "fixed") {
    issues.push(path + ".variant must be broken or fixed");
  }
  const outcome = record.outcome;
  if (!OUTCOMES.includes(outcome as LaunchRigReport["outcome"])) {
    issues.push(path + ".outcome must be passed, failed, or setup-error");
  }
  if (!Number.isInteger(record.exitCode) || (record.exitCode as number) < 0 || (record.exitCode as number) > 255) {
    issues.push(path + ".exitCode must be an integer from 0 to 255");
  }

  let checks: FixtureMatrixCheck[] = [];
  if (!Array.isArray(record.checks)) {
    issues.push(path + ".checks must be an array");
  } else {
    const seenCheckIds = new Set<string>();
    checks = record.checks.map((check, checkIndex) => {
      const parsed = parseRunCheck(check, path + ".checks[" + checkIndex + "]", issues);
      if (parsed.id && seenCheckIds.has(parsed.id)) {
        issues.push(path + ".checks[" + checkIndex + "].id duplicates " + parsed.id);
      }
      if (parsed.id) seenCheckIds.add(parsed.id);
      return parsed;
    });
  }

  return {
    caseId,
    variant: variant === "fixed" ? "fixed" : "broken",
    scenarioId,
    outcome: OUTCOMES.includes(outcome as LaunchRigReport["outcome"])
      ? (outcome as LaunchRigReport["outcome"])
      : "setup-error",
    exitCode: Number.isInteger(record.exitCode) ? (record.exitCode as number) : -1,
    checks,
  };
}

export function parseFixtureMatrixRuns(value: unknown): FixtureMatrixRun[] {
  const issues: string[] = [];
  if (!Array.isArray(value)) throw new FixtureMatrixValidationError(["runs must be an array"]);
  const runs = value.map((entry, index) => parseRun(entry, index, issues));
  const seen = new Set<string>();
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (!run) continue;
    const key = run.caseId + "\u0000" + run.variant;
    if (run.caseId && seen.has(key)) {
      issues.push("runs[" + index + "] duplicates case " + run.caseId + " variant " + run.variant);
    }
    if (run.caseId) seen.add(key);
  }
  if (issues.length > 0) throw new FixtureMatrixValidationError(issues);
  return runs;
}

export function createFixtureMatrixRun(input: {
  caseId: string;
  variant: FixtureMatrixVariant;
  scenarioId: string;
  exitCode: number;
  report: Pick<LaunchRigReport, "outcome" | "checks">;
}): FixtureMatrixRun {
  return {
    caseId: input.caseId,
    variant: input.variant,
    scenarioId: input.scenarioId,
    outcome: input.report.outcome,
    exitCode: input.exitCode,
    checks: input.report.checks.map(({ id, status, required }) => ({ id, status, required })),
  };
}

function runKey(caseId: string, variant: FixtureMatrixVariant): string {
  return caseId + "\u0000" + variant;
}

function issue(
  code: FixtureMatrixIssueCode,
  caseId: string,
  variant: FixtureMatrixVariant | null,
  message: string,
): FixtureMatrixIssue {
  return { code, caseId, variant, message };
}

function evaluateVariant(
  matrixCase: FixtureMatrixCaseV1,
  variant: FixtureMatrixVariant,
  matchingRuns: readonly FixtureMatrixRun[],
): FixtureMatrixVariantEvaluation {
  if (matchingRuns.length === 0) {
    const missing = issue(
      "missing-run",
      matrixCase.id,
      variant,
      "Missing " + variant + " run for matrix case " + matrixCase.id,
    );
    return { variant, accepted: false, outcome: null, exitCode: null, issues: [missing] };
  }
  if (matchingRuns.length > 1) {
    const duplicate = issue(
      "duplicate-run",
      matrixCase.id,
      variant,
      "Matrix case " + matrixCase.id + " has " + matchingRuns.length + " " + variant + " runs",
    );
    return { variant, accepted: false, outcome: null, exitCode: null, issues: [duplicate] };
  }

  const run = matchingRuns[0];
  if (!run) {
    throw new Error("Fixture matrix invariant failed: one matching run was expected");
  }
  const issues: FixtureMatrixIssue[] = [];
  const expected = EXPECTED_CONTRACT[variant];

  if (run.scenarioId !== matrixCase.scenarioId) {
    issues.push(
      issue(
        "scenario-mismatch",
        matrixCase.id,
        variant,
        "Expected scenario " + matrixCase.scenarioId + " but run selected " + run.scenarioId,
      ),
    );
  }
  if (run.outcome === "setup-error") {
    issues.push(issue("setup-error", matrixCase.id, variant, "Setup errors cannot satisfy a fixture matrix run"));
  }
  if (run.outcome !== expected.outcome) {
    issues.push(
      issue(
        "outcome-mismatch",
        matrixCase.id,
        variant,
        "Expected outcome " + expected.outcome + " but received " + run.outcome,
      ),
    );
  }
  if (run.exitCode !== expected.exitCode) {
    issues.push(
      issue(
        "exit-code-mismatch",
        matrixCase.id,
        variant,
        "Expected exit code " + expected.exitCode + " but received " + run.exitCode,
      ),
    );
  }

  const targetCheckId = "scenario." + matrixCase.scenarioId;
  const targetChecks = run.checks.filter((check) => check.id === targetCheckId);
  if (targetChecks.length === 0) {
    issues.push(
      issue(
        "missing-target-check",
        matrixCase.id,
        variant,
        "Run does not contain target check " + targetCheckId,
      ),
    );
  } else if (targetChecks.length > 1) {
    issues.push(
      issue(
        "duplicate-target-check",
        matrixCase.id,
        variant,
        "Run contains duplicate target check " + targetCheckId,
      ),
    );
  } else {
    const target = targetChecks[0];
    if (!target) throw new Error("Fixture matrix invariant failed: one target check was expected");
    if (!target.required) {
      issues.push(
        issue(
          "target-not-required",
          matrixCase.id,
          variant,
          "Target check " + targetCheckId + " must be required",
        ),
      );
    }
    if (target.status !== expected.scenarioStatus) {
      issues.push(
        issue(
          "target-status-mismatch",
          matrixCase.id,
          variant,
          "Expected target status " + expected.scenarioStatus + " but received " + target.status,
        ),
      );
    }
  }

  const unrelatedRequiredNonPasses = [...new Set(
    run.checks
      .filter((check) => check.required && check.status !== "pass" && check.id !== targetCheckId)
      .map((check) => check.id),
  )].sort();
  for (const checkId of unrelatedRequiredNonPasses) {
    issues.push(
      issue(
        "unrelated-required-failure",
        matrixCase.id,
        variant,
        "Unrelated required check did not pass: " + checkId,
      ),
    );
  }

  return {
    variant,
    accepted: issues.length === 0,
    outcome: run.outcome,
    exitCode: run.exitCode,
    issues,
  };
}

function compareRuns(left: FixtureMatrixRun, right: FixtureMatrixRun): number {
  return (
    left.caseId.localeCompare(right.caseId) ||
    left.variant.localeCompare(right.variant) ||
    left.scenarioId.localeCompare(right.scenarioId)
  );
}

export function evaluateFixtureMatrix(
  manifest: FixtureMatrixManifestV1,
  runs: readonly FixtureMatrixRun[],
): FixtureMatrixEvaluation {
  const expectedCaseIds = new Set(manifest.cases.map((matrixCase) => matrixCase.id));
  const runsByKey = new Map<string, FixtureMatrixRun[]>();
  const unexpectedIssues: FixtureMatrixIssue[] = [];

  for (const run of [...runs].sort(compareRuns)) {
    if (!expectedCaseIds.has(run.caseId)) {
      unexpectedIssues.push(
        issue(
          "unexpected-run",
          run.caseId,
          run.variant,
          "Run references unknown matrix case " + run.caseId,
        ),
      );
      continue;
    }
    const key = runKey(run.caseId, run.variant);
    const matching = runsByKey.get(key);
    if (matching) matching.push(run);
    else runsByKey.set(key, [run]);
  }

  const cases = manifest.cases.map((matrixCase) => {
    const broken = evaluateVariant(matrixCase, "broken", runsByKey.get(runKey(matrixCase.id, "broken")) ?? []);
    const fixed = evaluateVariant(matrixCase, "fixed", runsByKey.get(runKey(matrixCase.id, "fixed")) ?? []);
    return {
      id: matrixCase.id,
      scenarioId: matrixCase.scenarioId,
      accepted: broken.accepted && fixed.accepted,
      broken,
      fixed,
    };
  });
  const issues = [
    ...cases.flatMap((matrixCase) => [...matrixCase.broken.issues, ...matrixCase.fixed.issues]),
    ...unexpectedIssues,
  ];
  return { accepted: issues.length === 0, cases, issues };
}
