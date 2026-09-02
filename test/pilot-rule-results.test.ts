import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { stringify } from "yaml";
import { checkPilot, startPilot } from "../src/commands/pilot.js";
import type { DoctorOutput } from "../src/commands/doctor.js";
import { loadConfig } from "../src/config/load.js";
import { readPilotState, writePilotState } from "../src/pilot/store.js";
import type { PilotStateCoreV1 } from "../src/pilot/types.js";
import type { ResolvedLaunchRigConfig } from "../src/types.js";
import { getCoreRuleCatalog } from "../src/rules/catalog.js";
import { managedWalletExpectedSha256 } from "../src/security/wallet-artifact.js";

type JsonRecord = Record<string, unknown>;
type PilotRuleId = "LR019" | "LR020" | "LR021" | "LR022" | "LR023" | "LR024" | "LR025";
type PilotCheckId =
  | "pilot.state"
  | "pilot.project"
  | "pilot.wallet"
  | "pilot.device-policy"
  | "pilot.flows"
  | "pilot.mwa-coverage"
  | "pilot.environment";

interface PilotRuleExpectation {
  ruleId: PilotRuleId;
  classification: "positive" | "negative" | "conditional";
  checkId: PilotCheckId;
  status: "pass" | "fail" | "skip";
  summaryIncludes: string;
}

interface PilotRuleFixtureCase {
  id: string;
  mutation:
    | "none"
    | "corrupt-state"
    | "blocked-project"
    | "real-wallet"
    | "nonphysical-device-policy"
    | "reserved-flow-template"
    | "duplicate-flow-definition"
    | "environment-refusal";
  doctorOk: boolean;
  expectedDoctorCalls: 0 | 1;
  expectedExitCode: 0 | 2 | 3;
  expectedReadyToRecord: boolean;
  expectations: PilotRuleExpectation[];
}

interface PilotRuleFixtureCorpus {
  schemaVersion: 1;
  kind: "launchrig-pilot-rule-fixtures";
  profile: "pilot-rules-v1";
  status: "pre-award-foundation";
  ruleIds: PilotRuleId[];
  caseCount: 8;
  expectationCount: 56;
  grantMilestoneComplete: false;
  base: JsonRecord;
  baseFiles: Record<string, string>;
  cases: PilotRuleFixtureCase[];
  limitations: string[];
}

const CORE_FLOWS = [
  ["mwa-authorize", "authorize", "authorize.yaml"],
  ["mwa-siws", "siws", "siws.yaml"],
  ["mwa-sign-message", "sign-message", "sign-message.yaml"],
  ["mwa-reject", "reject", "reject.yaml"],
] as const;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function applyMutation(raw: JsonRecord, mutation: PilotRuleFixtureCase["mutation"]): void {
  const project = raw.project as JsonRecord;
  const wallet = raw.wallet as JsonRecord;
  const device = raw.device as JsonRecord;
  const artifacts = raw.artifacts as JsonRecord;
  const scenarios = raw.scenarios as JsonRecord[];
  if (mutation === "blocked-project") {
    project.packageName = "dev.launchrig.pilotfixture";
  } else if (mutation === "real-wallet") {
    wallet.mode = "real";
    wallet.packageName = "com.publisher.wallet";
    raw.scenarios = [];
    artifacts.screenshots = "never";
  } else if (mutation === "nonphysical-device-policy") {
    device.requirePhysical = false;
  } else if (mutation === "reserved-flow-template") {
    scenarios[0]!.flow = "./mwa-authorize.example.yaml";
  } else if (mutation === "duplicate-flow-definition") {
    scenarios[1]!.flow = "./authorize.yaml";
  }
}

async function writeFixtureFiles(
  directory: string,
  corpus: PilotRuleFixtureCorpus,
  packageName: string,
): Promise<void> {
  for (const [relativePath, source] of Object.entries(corpus.baseFiles)) {
    const target = path.join(directory, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      relativePath.endsWith(".yaml")
        ? source.replaceAll("com.publisher.launchrigfixture", packageName)
        : source,
      "utf8",
    );
  }
}

async function scopeFlows(
  config: ResolvedLaunchRigConfig,
  directory: string,
): Promise<Array<{ kind: string; scenarioId: string; fileSha256: string }>> {
  const configured = await Promise.all(
    CORE_FLOWS.map(async ([kind]) => {
      const scenario = config.scenarios.find((entry) => entry.kind === kind && entry.required);
      return scenario
        ? {
            kind,
            scenarioId: scenario.id,
            fileSha256: sha256(await readFile(scenario.resolvedFlow)),
          }
        : null;
    }),
  );
  if (
    configured.every((entry) => entry !== null) &&
    new Set(configured.map((entry) => entry!.scenarioId)).size === CORE_FLOWS.length &&
    new Set(configured.map((entry) => entry!.fileSha256)).size === CORE_FLOWS.length
  ) {
    return configured as Array<{ kind: string; scenarioId: string; fileSha256: string }>;
  }
  return await Promise.all(
    CORE_FLOWS.map(async ([kind, scenarioId, relativePath]) => ({
      kind,
      scenarioId,
      fileSha256: sha256(await readFile(path.join(directory, relativePath))),
    })),
  );
}

async function writeScope(directory: string, config: ResolvedLaunchRigConfig): Promise<string> {
  const walletSha256 = managedWalletExpectedSha256("com.solana.mwallet");
  assert.ok(walletSha256);
  assert.ok(config.resolvedApk);
  const scope = {
    schemaVersion: 1,
    kind: "launchrig-pilot-session-scope",
    profile: "external-mwa-pilot-scope-v1",
    scopeRef: "urn:launchrig:scope:123e4567-e89b-42d3-a456-426614174000",
    operatorRef: "urn:launchrig:operator:223e4567-e89b-42d3-a456-426614174000",
    pilotRef: "urn:launchrig:pilot:323e4567-e89b-42d3-a456-426614174000",
    deviceRef: "urn:launchrig:device:423e4567-e89b-42d3-a456-426614174000",
    bundle: {
      bundleId: "sha256:" + sha256("generated pilot fixture bundle"),
      manifestSha256: sha256("generated pilot fixture manifest"),
      sha256SumsSha256: sha256("generated pilot fixture sums"),
      packageSha256: sha256("generated pilot fixture package"),
    },
    inputs: {
      configSha256: sha256(await readFile(config.configPath)),
      appBuildSha256: sha256(await readFile(config.resolvedApk)),
      walletArtifactSha256: walletSha256,
      flows: await scopeFlows(config, directory),
    },
    policy: {
      network: config.target.network,
      walletMode: config.wallet.mode === "reference-fakewallet" ? "reference-fakewallet" : "mock-mwa",
      physicalAndroidRequired: true,
      attendedExecutionRequired: true,
      manualWalletActionsRequired: true,
      valuableAssetsAllowed: false,
      capture: {
        screenshots: config.artifacts.screenshots,
        includeLogcat: config.privacy.includeLogcat,
        logcatLines: config.privacy.logcatLines,
      },
      retention: {
        maxRuns: config.artifacts.retention,
        expiresOn: "2099-12-31",
        deletionMethod: "standard-delete",
      },
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
  const target = path.join(directory, "pilot-session-scope.json");
  await writeFile(target, JSON.stringify(scope, null, 2) + "\n", { mode: 0o600 });
  return target;
}

function doctorOutput(ok: boolean, config: ResolvedLaunchRigConfig): DoctorOutput {
  const walletSha256 = managedWalletExpectedSha256("com.solana.mwallet");
  assert.ok(walletSha256);
  return {
    ok,
    adb: { path: "/generated/adb", version: "Android Debug Bridge 1.0.41" },
    maestro: { required: true, path: "/generated/maestro", installed: true, version: "2.8.0" },
    device: {
      serial: "***",
      manufacturer: "Generated",
      model: "Process Double",
      androidVersion: "16",
      apiLevel: 36,
      abi: "arm64-v8a",
      securityPatch: "2026-08-01",
      isEmulator: false,
    },
    packages: [
      {
        packageName: config.project.packageName,
        installed: true,
        willInstall: false,
        role: "app",
        binaryReady: true,
      },
      {
        packageName: config.wallet.packageName ?? "com.solana.mwallet",
        installed: true,
        willInstall: false,
        role: "wallet",
        installedSha256: walletSha256,
        expectedSha256: walletSha256,
        binaryReady: true,
      },
    ],
    issues: ok ? [] : ["Generated doctor refusal for pilot rule fixture"],
  };
}

function stableProjection(output: Awaited<ReturnType<typeof checkPilot>>): unknown {
  return {
    readyToRecord: output.readyToRecord,
    exitCode: output.exitCode,
    checks: output.checks,
    doctorOk: output.doctor?.ok ?? null,
    technicalPilot: output.technicalPilot,
    externalGrantGate: output.externalGrantGate,
  };
}

test("LR019 through LR025 fixture corpus is schema-valid, deterministic, and device-free", async () => {
  const schema = JSON.parse(
    await readFile(
      path.join(process.cwd(), "schemas", "launchrig-pilot-rule-fixtures.schema.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const corpus = JSON.parse(
    await readFile(
      path.join(process.cwd(), "schemas", "fixtures", "launchrig-pilot-rule-fixtures.v1.json"),
      "utf8",
    ),
  ) as PilotRuleFixtureCorpus;
  const validator = new Ajv2020({
    allErrors: true,
    strictSchema: true,
    strictNumbers: true,
    strictTypes: false,
    strictTuples: true,
    strictRequired: false,
    useDefaults: false,
    coerceTypes: false,
  }).compile(schema);
  assert.equal(validator(structuredClone(corpus)), true, JSON.stringify(validator.errors));
  assert.deepEqual(Object.keys(corpus), [
    "schemaVersion",
    "kind",
    "profile",
    "status",
    "ruleIds",
    "caseCount",
    "expectationCount",
    "grantMilestoneComplete",
    "base",
    "baseFiles",
    "cases",
    "limitations",
  ]);
  assert.equal(corpus.caseCount, corpus.cases.length);
  assert.equal(corpus.expectationCount, 56);
  assert.equal(
    corpus.cases.reduce((count, fixture) => count + fixture.expectations.length, 0),
    corpus.expectationCount,
  );
  assert.equal(new Set(corpus.cases.map((fixture) => fixture.id)).size, corpus.caseCount);
  assert.equal(corpus.grantMilestoneComplete, false);

  const catalogRules = new Map(
    getCoreRuleCatalog().rules
      .filter((rule) => rule.domain === "pilot")
      .map((rule) => [rule.ruleId as PilotRuleId, rule]),
  );
  assert.deepEqual([...catalogRules.keys()], corpus.ruleIds);
  const positiveCoverage = new Set<PilotRuleId>();
  const negativeCoverage = new Set<PilotRuleId>();
  const conditionalCoverage = new Set<PilotRuleId>();
  const root = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-rules-"));
  try {
    for (const fixture of corpus.cases) {
      const projections: unknown[] = [];
      for (const pass of [1, 2]) {
        const directory = path.join(root, fixture.id, "run-" + pass);
        await mkdir(directory, { recursive: true });
        const raw = structuredClone(corpus.base);
        applyMutation(raw, fixture.mutation);
        const packageName = String((raw.project as JsonRecord).packageName);
        await writeFixtureFiles(directory, corpus, packageName);
        const configPath = path.join(directory, "launchrig.yml");
        await writeFile(configPath, stringify(raw), "utf8");
        const config = await loadConfig(configPath);
        const scopePath = await writeScope(directory, config);
        const pilotId = "fixture-" + fixture.id;
        const started = await startPilot({
          pilotId,
          configPath,
          now: () => new Date("2026-09-01T08:00:00.000Z"),
        });
        if (fixture.mutation === "corrupt-state") {
          const state = JSON.parse(await readFile(started.statePath, "utf8")) as JsonRecord;
          state.integritySha256 = "0".repeat(64);
          await writeFile(started.statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
        }
        const stateBefore = await readFile(started.statePath, "utf8");
        let doctorCalls = 0;
        const output = await checkPilot({
          pilotId,
          configPath,
          scopePath,
          doctorRunner: async (options) => {
            doctorCalls += 1;
            assert.equal(options.verifyInstalledArtifactHashes, true);
            return doctorOutput(fixture.doctorOk, config);
          },
        });
        assert.equal(output.exitCode, fixture.expectedExitCode, fixture.id + " exit code");
        assert.equal(output.readyToRecord, fixture.expectedReadyToRecord, fixture.id + " readiness");
        assert.equal(doctorCalls, fixture.expectedDoctorCalls, fixture.id + " doctor calls");
        assert.equal(output.checks.length, fixture.expectations.length, fixture.id + " check count");
        assert.deepEqual(
          output.checks.map((check) => check.id),
          fixture.expectations.map((expectation) => expectation.checkId),
          fixture.id + " check order",
        );
        for (const [index, expectation] of fixture.expectations.entries()) {
          const rule = catalogRules.get(expectation.ruleId);
          assert.ok(rule, expectation.ruleId);
          assert.equal(rule.checkId, expectation.checkId, expectation.ruleId + " catalog mapping");
          const check = output.checks[index];
          assert.equal(check?.status, expectation.status, fixture.id + " " + expectation.ruleId + " status");
          assert.ok(
            check?.summary.includes(expectation.summaryIncludes),
            fixture.id + " " + expectation.ruleId + " summary",
          );
          if (expectation.classification === "positive") positiveCoverage.add(expectation.ruleId);
          else if (expectation.classification === "negative") negativeCoverage.add(expectation.ruleId);
          else conditionalCoverage.add(expectation.ruleId);
        }
        assert.equal(output.technicalPilot.qualified, false);
        assert.equal(output.externalGrantGate.status, "not-established");
        assert.equal(output.externalGrantGate.grantReady, false);
        assert.equal(await readFile(started.statePath, "utf8"), stateBefore, fixture.id + " state mutation");
        const summaries = output.checks.map((check) => check.summary).join("\n");
        assert.doesNotMatch(summaries, /urn:launchrig|launchrig-pilot-rules-|fixture-[a-z0-9-]+\/run-/);
        projections.push(stableProjection(output));
      }
      assert.deepEqual(projections[1], projections[0], fixture.id + " deterministic normalized rerun");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual([...positiveCoverage].sort(), [...corpus.ruleIds].sort());
  assert.deepEqual([...negativeCoverage].sort(), [...corpus.ruleIds].sort());
  assert.ok(conditionalCoverage.has("LR025"));
});

test("pilot state identity mismatch emits a stable LR019 refusal", async () => {
  const corpus = JSON.parse(
    await readFile(
      path.join(process.cwd(), "schemas", "fixtures", "launchrig-pilot-rule-fixtures.v1.json"),
      "utf8",
    ),
  ) as PilotRuleFixtureCorpus;
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-state-binding-"));
  try {
    const raw = structuredClone(corpus.base);
    const packageName = String((raw.project as JsonRecord).packageName);
    await writeFixtureFiles(directory, corpus, packageName);
    const configPath = path.join(directory, "launchrig.yml");
    await writeFile(configPath, stringify(raw), "utf8");
    const config = await loadConfig(configPath);
    const scopePath = await writeScope(directory, config);
    const pilotId = "fixture-state-binding";
    const started = await startPilot({
      pilotId,
      configPath,
      now: () => new Date("2026-09-01T08:00:00.000Z"),
    });
    const stored = await readPilotState(started.statePath);
    const { integritySha256: _integritySha256, ...core } = stored;
    await writePilotState(
      started.statePath,
      { ...core, pilotId: "different-pilot" } as PilotStateCoreV1,
      true,
    );
    const stateBefore = await readFile(started.statePath, "utf8");
    let doctorCalls = 0;
    const output = await checkPilot({
      pilotId,
      configPath,
      scopePath,
      doctorRunner: async () => {
        doctorCalls += 1;
        return doctorOutput(true, config);
      },
    });
    assert.equal(output.exitCode, 3);
    assert.equal(output.readyToRecord, false);
    assert.equal(doctorCalls, 0);
    assert.deepEqual(
      output.checks.map((check) => [check.id, check.status]),
      [
        ["pilot.state", "fail"],
        ["pilot.project", "skip"],
        ["pilot.wallet", "skip"],
        ["pilot.device-policy", "skip"],
        ["pilot.flows", "skip"],
        ["pilot.mwa-coverage", "skip"],
        ["pilot.environment", "skip"],
      ],
    );
    assert.match(output.checks[0]!.summary, /Pilot state ID does not match its directory/);
    assert.equal(output.technicalPilot.qualified, false);
    assert.equal(output.externalGrantGate.grantReady, false);
    assert.equal(await readFile(started.statePath, "utf8"), stateBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
