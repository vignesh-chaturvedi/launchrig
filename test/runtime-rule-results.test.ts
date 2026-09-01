import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/load.js";
import { getCoreRuleCatalog } from "../src/rules/catalog.js";
import { runLaunchRig } from "../src/runner/orchestrator.js";
import { managedWalletExpectedSha256 } from "../src/security/wallet-artifact.js";

type JsonRecord = Record<string, unknown>;
type RuntimeRuleId =
  | "LR006"
  | "LR007"
  | "LR008"
  | "LR009"
  | "LR010"
  | "LR011"
  | "LR012"
  | "LR013"
  | "LR014"
  | "LR015"
  | "LR016"
  | "LR017"
  | "LR018";

interface RuntimeBehavior {
  adbVersionExitCode: 0 | 1;
  deviceState: "device" | "unauthorized";
  emulatorProperty: boolean;
  apiLevel: number;
  appInstalled: boolean;
  appInstallExitCode: 0 | 1;
  appBinary: "match" | "mismatch";
  walletInstalled: boolean;
  walletBinary: "match" | "mismatch";
  maestroVersionExitCode: 0 | 1;
  scenarioExitCode: 0 | 1;
}

interface RuntimeExpectation {
  ruleId: RuntimeRuleId;
  polarity: "positive" | "negative";
  checkId: string;
  status: "pass" | "fail" | "warn" | "absent";
  required: boolean | null;
}

interface RuntimeFixtureCase {
  id: string;
  set: Record<string, unknown>;
  remove: string[];
  behavior: Partial<RuntimeBehavior>;
  options: {
    scenarioId: string | null;
    requireInstalledArtifactHashes: boolean;
  };
  expectedExitCode: 0 | 1 | 3;
  expectedOutcome: "passed" | "failed" | "setup-error";
  expectedReadiness: "Android Device Ready" | "Android/MWA Ready" | "Not Ready";
  expectations: RuntimeExpectation[];
}

interface RuntimeFixtureCorpus {
  schemaVersion: 1;
  kind: "launchrig-runtime-rule-fixtures";
  profile: "runtime-rules-v1";
  status: "pre-award-foundation";
  ruleIds: RuntimeRuleId[];
  caseCount: number;
  expectationCount: number;
  grantMilestoneComplete: false;
  base: JsonRecord;
  baseFiles: Record<string, string>;
  defaultBehavior: RuntimeBehavior;
  cases: RuntimeFixtureCase[];
  limitations: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointerSegments(pointer: string): string[] {
  assert.match(pointer, /^\/(?:[^/]*(?:\/[^/]*)*)?$/);
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function pointerParent(target: JsonRecord, pointer: string): { parent: JsonRecord; key: string } {
  const segments = pointerSegments(pointer);
  assert.ok(segments.length > 0);
  let current: unknown = target;
  for (const segment of segments.slice(0, -1)) {
    assert.ok(isRecord(current), "JSON Pointer parent must be an object: " + pointer);
    current = current[segment];
  }
  assert.ok(isRecord(current), "JSON Pointer parent must be an object: " + pointer);
  return { parent: current, key: segments.at(-1) ?? "" };
}

function materializeConfig(base: JsonRecord, fixture: RuntimeFixtureCase): JsonRecord {
  const value = structuredClone(base);
  for (const [pointer, entry] of Object.entries(fixture.set)) {
    const { parent, key } = pointerParent(value, pointer);
    parent[key] = structuredClone(entry);
  }
  for (const pointer of fixture.remove) {
    const { parent, key } = pointerParent(value, pointer);
    delete parent[key];
  }
  return value;
}

function fakeAdbSource(input: {
  behavior: RuntimeBehavior;
  appPackage: string;
  walletPackage: string;
  appSha256: string;
  walletSha256: string;
}): string {
  const fixture = JSON.stringify(input);
  return `#!${process.execPath}
const fixture = ${fixture};
const args = process.argv.slice(2);
const fail = (message) => {
  if (message) console.error(message);
  process.exitCode = 1;
};
const shell = args[0] === "-s" && args[2] === "shell";
if (args[0] === "version") {
  if (fixture.behavior.adbVersionExitCode === 0) console.log("Android Debug Bridge version 1.0.41");
  else fail("Fixture ADB version failure");
} else if (args[0] === "devices" && args[1] === "-l") {
  console.log("List of devices attached");
  console.log("RULEPHONE " + fixture.behavior.deviceState + " usb:1-1 product:fixture model:Fixture_Phone device:fixture transport_id:1");
} else if (shell && args[3] === "getprop") {
  console.log("[ro.product.manufacturer]: [Fixture]\\n[ro.product.model]: [Phone]\\n[ro.build.version.release]: [16]\\n[ro.build.version.sdk]: [" + fixture.behavior.apiLevel + "]\\n[ro.product.cpu.abi]: [arm64-v8a]\\n[ro.build.version.security_patch]: [2026-08-01]\\n[ro.kernel.qemu]: [" + (fixture.behavior.emulatorProperty ? "1" : "0") + "]");
} else if (shell && args[3] === "dumpsys" && args[4] === "battery") {
  console.log("level: 80");
} else if (shell && args[3] === "dumpsys" && args[4] === "package") {
  console.log("  versionCode=1 minSdk=23 targetSdk=36\\n  versionName=1.0.0");
} else if (shell && args[3] === "df") {
  console.log("Filesystem 1K-blocks Used Available Use% Mounted on\\n/dev/data 1000000 1000 999000 1% /data");
} else if (shell && args[3] === "pm" && args[4] === "path") {
  const packageName = args[5];
  const installed = packageName === fixture.appPackage
    ? fixture.behavior.appInstalled
    : packageName === fixture.walletPackage && fixture.behavior.walletInstalled;
  if (installed) console.log("package:/data/app/" + packageName + "/base.apk");
  else fail("Package not installed");
} else if (shell && (args[3] === "sha256sum" || (args[3] === "toybox" && args[4] === "sha256sum"))) {
  const apkPath = args[3] === "sha256sum" ? args[4] : args[5];
  const isWallet = apkPath.includes(fixture.walletPackage);
  const digest = isWallet
    ? (fixture.behavior.walletBinary === "match" ? fixture.walletSha256 : "0".repeat(64))
    : (fixture.behavior.appBinary === "match" ? fixture.appSha256 : "0".repeat(64));
  console.log(digest + "  " + apkPath);
} else if (args[0] === "-s" && args[2] === "install" && args[3] === "-r") {
  if (fixture.behavior.appInstallExitCode === 0) console.log("Success");
  else fail("Fixture APK install failure");
} else {
  fail("Unexpected fixture ADB arguments: " + args.join(" "));
}
`;
}

function fakeMaestroSource(behavior: RuntimeBehavior): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const behavior = ${JSON.stringify(behavior)};
const args = process.argv.slice(2);
if (args[0] === "--version") {
  if (behavior.maestroVersionExitCode === 0) console.log("2.8.0");
  else {
    console.error("Fixture Maestro version failure");
    process.exitCode = 1;
  }
} else {
  const device = args.find((entry) => entry.startsWith("--device="));
  const flowPath = args.at(-1) || "";
  if (device !== "--device=RULEPHONE" || !flowPath.includes("launchrig-flow-")) {
    console.error("Fixture Maestro received an unsafe invocation");
    process.exitCode = 1;
  } else {
    const outputIndex = args.indexOf("--output");
    const output = outputIndex >= 0 ? args[outputIndex + 1] : "";
    if (output) {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, "<testsuite tests=\\"1\\" failures=\\"" + behavior.scenarioExitCode + "\\"/>");
    }
    if (behavior.scenarioExitCode === 0) console.log("Fixture flow passed");
    else {
      console.error("Fixture flow failed");
      process.exitCode = 1;
    }
  }
}
`;
}

async function createExecutable(directory: string, name: string, source: string): Promise<string> {
  const target = path.join(directory, name);
  await writeFile(target, source, "utf8");
  await chmod(target, 0o755);
  return target;
}

async function materializeFixture(
  directory: string,
  corpus: RuntimeFixtureCorpus,
  fixture: RuntimeFixtureCase,
): Promise<{ configPath: string; adbPath: string; maestroPath: string }> {
  await mkdir(directory, { recursive: true });
  for (const [relativePath, source] of Object.entries(corpus.baseFiles)) {
    const destination = path.join(directory, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source, "utf8");
  }
  const rawConfig = materializeConfig(corpus.base, fixture);
  const configPath = path.join(directory, "launchrig.yml");
  await writeFile(configPath, stringify(rawConfig), "utf8");

  const project = rawConfig.project as JsonRecord;
  const wallet = rawConfig.wallet as JsonRecord;
  const appPackage = String(project.packageName);
  const walletPackage = String(wallet.packageName);
  const appSha256 = createHash("sha256").update(corpus.baseFiles["app.apk"] ?? "").digest("hex");
  const walletSha256 = managedWalletExpectedSha256(walletPackage);
  assert.ok(walletSha256);
  const behavior = { ...corpus.defaultBehavior, ...fixture.behavior };
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  return {
    configPath,
    adbPath: await createExecutable(
      bin,
      "fixture-adb",
      fakeAdbSource({ behavior, appPackage, walletPackage, appSha256, walletSha256 }),
    ),
    maestroPath: await createExecutable(bin, "fixture-maestro", fakeMaestroSource(behavior)),
  };
}

function stableProjection(output: Awaited<ReturnType<typeof runLaunchRig>>): unknown {
  return {
    exitCode: output.exitCode,
    outcome: output.report.outcome,
    readiness: output.report.readiness,
    checks: output.report.checks.map((check) => ({
      id: check.id,
      status: check.status,
      required: check.required,
      summary: check.summary,
    })),
  };
}

test("LR006 through LR018 fixture corpus is schema-valid, deterministic, and device-free", async () => {
  const schema = JSON.parse(
    await readFile(
      path.join(process.cwd(), "schemas", "launchrig-runtime-rule-fixtures.schema.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const corpus = JSON.parse(
    await readFile(
      path.join(process.cwd(), "schemas", "fixtures", "launchrig-runtime-rule-fixtures.v1.json"),
      "utf8",
    ),
  ) as RuntimeFixtureCorpus;
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
    "defaultBehavior",
    "cases",
    "limitations",
  ]);
  assert.equal(corpus.caseCount, corpus.cases.length);
  assert.equal(corpus.expectationCount, 26);
  assert.equal(
    corpus.cases.reduce((count, fixture) => count + fixture.expectations.length, 0),
    corpus.expectationCount,
  );
  assert.equal(new Set(corpus.cases.map((fixture) => fixture.id)).size, corpus.caseCount);
  assert.equal(corpus.grantMilestoneComplete, false);

  const catalogRules = new Map(
    getCoreRuleCatalog().rules
      .filter((rule) => rule.domain === "runtime")
      .map((rule) => [rule.ruleId as RuntimeRuleId, rule]),
  );
  assert.deepEqual([...catalogRules.keys()], corpus.ruleIds);
  const positiveCoverage = new Set<RuntimeRuleId>();
  const negativeCoverage = new Set<RuntimeRuleId>();
  const root = await mkdtemp(path.join(os.tmpdir(), "launchrig-runtime-rules-"));
  try {
    for (const fixture of corpus.cases) {
      const projections: unknown[] = [];
      for (const pass of [1, 2]) {
        const directory = path.join(root, fixture.id, "run-" + pass);
        const materialized = await materializeFixture(directory, corpus, fixture);
        const config = await loadConfig(materialized.configPath);
        const output = await runLaunchRig(config, {
          adbPath: materialized.adbPath,
          maestroPath: materialized.maestroPath,
          ...(fixture.options.scenarioId ? { scenarioId: fixture.options.scenarioId } : {}),
          requireInstalledArtifactHashes: fixture.options.requireInstalledArtifactHashes,
          env: {},
        });
        assert.equal(output.exitCode, fixture.expectedExitCode, fixture.id + " exit code");
        assert.equal(output.report.outcome, fixture.expectedOutcome, fixture.id + " outcome");
        assert.equal(output.report.readiness, fixture.expectedReadiness, fixture.id + " readiness");
        assert.doesNotMatch(JSON.stringify(output.report), /RULEPHONE/, fixture.id + " serial redaction");
        for (const expectation of fixture.expectations) {
          const rule = catalogRules.get(expectation.ruleId);
          assert.ok(rule, expectation.ruleId);
          if (rule.checkId === "scenario.*") {
            assert.match(expectation.checkId, /^scenario\.(?!none$|selection$)[a-z][a-z0-9-]*$/);
          } else {
            assert.equal(expectation.checkId, rule.checkId, expectation.ruleId + " catalog mapping");
          }
          const matches = output.report.checks.filter((check) => check.id === expectation.checkId);
          if (expectation.status === "absent") {
            assert.equal(matches.length, 0, fixture.id + " " + expectation.ruleId + " absence");
            assert.equal(expectation.required, null);
          } else {
            assert.equal(matches.length, 1, fixture.id + " " + expectation.ruleId + " emission");
            assert.equal(matches[0]?.status, expectation.status, fixture.id + " " + expectation.ruleId + " status");
            assert.equal(matches[0]?.required, expectation.required, fixture.id + " " + expectation.ruleId + " required");
          }
          if (expectation.polarity === "positive") {
            assert.ok(
              expectation.status === "pass" || expectation.status === "warn",
              fixture.id + " positive expectation status",
            );
            positiveCoverage.add(expectation.ruleId);
          } else {
            assert.ok(
              expectation.status === "fail" || expectation.status === "absent",
              fixture.id + " negative expectation status",
            );
            negativeCoverage.add(expectation.ruleId);
          }
        }
        projections.push(stableProjection(output));
      }
      assert.deepEqual(projections[1], projections[0], fixture.id + " deterministic normalized rerun");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual([...positiveCoverage].sort(), [...corpus.ruleIds].sort());
  assert.deepEqual([...negativeCoverage].sort(), [...corpus.ruleIds].sort());
});
