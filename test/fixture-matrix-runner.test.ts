import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { parseAllDocuments } from "yaml";
import { runCli, type CliIO } from "../src/cli.js";
import {
  FixtureMatrixEnvironmentError,
  runFixtureMatrix,
  type FixtureMatrixProjectRunner,
  type RunFixtureMatrixOptions,
  type RunFixtureMatrixOutput,
} from "../src/commands/matrix.js";
import { loadConfig } from "../src/config/load.js";
import { FixtureMatrixValidationError, type FixtureMatrixVariant } from "../src/fixtures/matrix.js";
import { createReport } from "../src/report/model.js";
import type { RunOutput } from "../src/runner/orchestrator.js";

const WORKSPACE = process.cwd();
const BROKEN_CONFIG = path.join(WORKSPACE, "launchrig-fixture-broken.yml");
const FIXED_CONFIG = path.join(WORKSPACE, "launchrig-fixture-fixed.yml");
const BROKEN_FLOW = path.join(WORKSPACE, "launchrig-flows", "fixture-rejection-broken.yaml");
const FIXED_FLOW = path.join(WORKSPACE, "launchrig-flows", "fixture-rejection-fixed.yaml");
const SCENARIO_ID = "rejection-recovery";
const APP_PACKAGE = "dev.launchrig.fixture";
const WALLET_PACKAGE = "com.solana.mwallet";
const BROKEN_URI = "launchrig://fixture/rejection?variant=broken";
const FIXED_URI = "launchrig://fixture/rejection?variant=fixed";

interface MatrixWorkspace {
  root: string;
  brokenConfig: string;
  fixedConfig: string;
  appArtifact: string;
  appSha256: string;
  walletSha256: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
}

function flowSource(uri: string): string {
  return [
    "appId: " + APP_PACKAGE,
    "name: Controlled wallet rejection recovery",
    "---",
    "- openLink:",
    '    link: "' + uri + '"',
    "- assertVisible:",
    '    id: "fixture-ready"',
    "",
  ].join("\n");
}

function configSource(variant: FixtureMatrixVariant, appArtifactName: string, walletArtifactName: string): string {
  const policy = variant === "broken" ? "always" : "if-missing";
  return [
    "version: 1",
    "project:",
    '  name: "Fixture ' + variant + '"',
    "  packageName: " + APP_PACKAGE,
    "  apk: ./.launchrig/cache/apks/" + appArtifactName,
    "  install: true",
    "  installPolicy: " + policy,
    "target:",
    "  network: devnet",
    "device:",
    "  requirePhysical: true",
    "  minimumApiLevel: 26",
    "wallet:",
    "  mode: mock-mwa",
    "  packageName: " + WALLET_PACKAGE,
    "  apk: ./.launchrig/cache/apks/" + walletArtifactName,
    "  install: true",
    "  installPolicy: " + policy,
    "scenarios:",
    "  - id: " + SCENARIO_ID,
    "    kind: mwa-reject",
    '    name: "Controlled wallet rejection recovery"',
    "    flow: ./launchrig-flows/fixture-rejection-" + variant + ".yaml",
    "    required: true",
    "    timeoutMs: 120000",
    "artifacts:",
    "  directory: ./results/" + variant,
    "  screenshots: failure",
    "  retention: 5",
    "privacy:",
    "  includeLogcat: false",
    "  logcatLines: 200",
    "  redactPatterns: []",
    "tooling: {}",
    "",
  ].join("\n");
}

async function createMatrixWorkspace(
  context: TestContext,
  options: { brokenFlowUri?: string } = {},
): Promise<MatrixWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), "launchrig-matrix-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const fixturesDirectory = path.join(root, "fixtures");
  const flowsDirectory = path.join(root, "launchrig-flows");
  const apkDirectory = path.join(root, ".launchrig", "cache", "apks");
  await Promise.all([
    mkdir(fixturesDirectory, { recursive: true }),
    mkdir(flowsDirectory, { recursive: true }),
    mkdir(apkDirectory, { recursive: true }),
  ]);

  const appArtifactName = "controlled-app.apk";
  const walletArtifactName = "mock-wallet.apk";
  const appBytes = Buffer.from("controlled fixture APK bytes");
  const walletBytes = Buffer.from("mock MWA APK bytes");
  const appArtifact = path.join(apkDirectory, appArtifactName);
  const walletArtifact = path.join(apkDirectory, walletArtifactName);
  const appSha256 = sha256(appBytes);
  const walletSha256 = sha256(walletBytes);
  const brokenFlowSource = flowSource(options.brokenFlowUri ?? BROKEN_URI);
  const fixedFlowSource = flowSource(FIXED_URI);
  const brokenConfigSource = configSource("broken", appArtifactName, walletArtifactName);
  const fixedConfigSource = configSource("fixed", appArtifactName, walletArtifactName);
  const matrixManifest = {
    schemaVersion: 1,
    cases: [
      {
        id: SCENARIO_ID,
        name: "Wallet rejection recovery",
        scenarioId: SCENARIO_ID,
        expectations: {
          broken: {
            launchUri: BROKEN_URI,
            configSha256: sha256(brokenConfigSource),
            flowSha256: sha256(brokenFlowSource),
            scenarioStatus: "fail",
            outcome: "failed",
            exitCode: 1,
          },
          fixed: {
            launchUri: FIXED_URI,
            configSha256: sha256(fixedConfigSource),
            flowSha256: sha256(fixedFlowSource),
            scenarioStatus: "pass",
            outcome: "passed",
            exitCode: 0,
          },
        },
      },
    ],
  };
  const appManifest = {
    schemaVersion: 1,
    packageName: APP_PACKAGE,
    versionName: "0.1.0",
    versionCode: 1,
    network: "devnet",
    deepLinks: { broken: BROKEN_URI, fixed: FIXED_URI },
    build: { artifactName: appArtifactName },
    validatedArtifact: { size: appBytes.byteLength, sha256: appSha256 },
  };
  const walletManifest = {
    schemaVersion: 1,
    packageName: WALLET_PACKAGE,
    versionName: "1.0.1",
    versionCode: 2,
    artifactName: walletArtifactName,
    validatedArtifact: { size: walletBytes.byteLength, sha256: walletSha256 },
  };
  const brokenConfig = path.join(root, "launchrig-fixture-broken.yml");
  const fixedConfig = path.join(root, "launchrig-fixture-fixed.yml");
  await Promise.all([
    writeFile(path.join(fixturesDirectory, "launchrig-matrix.v1.json"), JSON.stringify(matrixManifest)),
    writeFile(path.join(fixturesDirectory, "launchrig-dapp-v0.1.0.json"), JSON.stringify(appManifest)),
    writeFile(path.join(fixturesDirectory, "mock-mwa-main.json"), JSON.stringify(walletManifest)),
    writeFile(path.join(flowsDirectory, "fixture-rejection-broken.yaml"), brokenFlowSource),
    writeFile(path.join(flowsDirectory, "fixture-rejection-fixed.yaml"), fixedFlowSource),
    writeFile(brokenConfig, brokenConfigSource),
    writeFile(fixedConfig, fixedConfigSource),
    writeFile(appArtifact, appBytes),
    writeFile(walletArtifact, walletBytes),
  ]);
  return { root, brokenConfig, fixedConfig, appArtifact, appSha256, walletSha256 };
}

function outputFor(workspace: MatrixWorkspace, variant: FixtureMatrixVariant): RunOutput {
  const broken = variant === "broken";
  const startedAt = new Date("2026-08-25T12:00:00.000Z");
  const completedAt = new Date("2026-08-25T12:00:01.000Z");
  const evidenceChecks = [
    "tool.adb",
    "device.connected",
    "device.api",
    "app.install",
    "app.installed",
    "wallet.install",
    "wallet.installed",
    "tool.maestro",
  ].map((id) => ({
    id,
    name: id,
    status: "pass" as const,
    required: true,
    durationMs: 1,
    summary: id + " passed",
  }));
  const report = createReport({
    runId: "fixture-" + variant,
    project: "Fixture " + variant,
    packageName: APP_PACKAGE,
    network: "devnet",
    startedAt,
    completedAt,
    checks: [
      ...evidenceChecks,
      {
        id: "scenario." + SCENARIO_ID,
        name: "Controlled wallet rejection recovery",
        status: broken ? "fail" : "pass",
        required: true,
        durationMs: 1000,
        summary: broken ? "Healthy recovery assertions failed" : "Healthy recovery assertions passed",
      },
    ],
    device: {
      serial: "TEST-DEVICE",
      manufacturer: "LaunchRig",
      model: "Physical fixture",
      androidVersion: "12",
      apiLevel: 31,
      abi: "arm64-v8a",
      securityPatch: "2026-08-01",
      isEmulator: false,
    },
    app: { packageName: APP_PACKAGE, versionName: "0.1.0", versionCode: "1" },
    wallet: { packageName: WALLET_PACKAGE, versionName: "1.0.1", versionCode: "2" },
  });
  const directory = path.join(workspace.root, "results", variant, "fixture-run");
  return {
    report,
    artifacts: {
      directory,
      json: path.join(directory, "launchrig-report.json"),
      html: path.join(directory, "launchrig-report.html"),
      junit: path.join(directory, "launchrig-junit.xml"),
      redactionCount: 0,
    },
    exitCode: broken ? 1 : 0,
  };
}

function fakeProjectRunner(
  workspace: MatrixWorkspace,
  brokenOutput: RunOutput,
  fixedOutput: RunOutput,
  calls: Array<{ configPath: string; scenarioId: string | undefined }>,
): FixtureMatrixProjectRunner {
  return async (configPath, options = {}) => {
    calls.push({ configPath, scenarioId: options.scenarioId });
    return configPath === workspace.brokenConfig ? brokenOutput : fixedOutput;
  };
}

function captureIO(): { io: CliIO; output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      out: (message) => output.push(message),
      error: (message) => errors.push(message),
    },
    output,
    errors,
  };
}

test("broken reinstalls the verified pair and fixed reuses it", async () => {
  const [broken, fixed] = await Promise.all([loadConfig(BROKEN_CONFIG), loadConfig(FIXED_CONFIG)]);
  const expectedAppApk = path.join(
    WORKSPACE,
    ".launchrig",
    "cache",
    "apks",
    "launchrig-fixture-v0.1.0-arm64-release.apk",
  );
  const expectedWalletApk = path.join(
    WORKSPACE,
    ".launchrig",
    "cache",
    "apks",
    "mock-mwa-1.0.1-d444aff-debug.apk",
  );

  for (const config of [broken, fixed]) {
    assert.equal(config.project.packageName, APP_PACKAGE);
    assert.equal(config.project.install, true);
    assert.equal(config.resolvedApk, expectedAppApk);
    assert.equal(config.target.network, "devnet");
    assert.equal(config.wallet.mode, "mock-mwa");
    assert.equal(config.wallet.packageName, WALLET_PACKAGE);
    assert.equal(config.wallet.install, true);
    assert.equal(config.resolvedWalletApk, expectedWalletApk);
    assert.equal(config.scenarios.length, 1);
    assert.equal(config.scenarios[0]?.id, SCENARIO_ID);
    assert.equal(config.scenarios[0]?.required, true);
  }
  assert.equal(broken.project.installPolicy, "always");
  assert.equal(broken.wallet.installPolicy, "always");
  assert.equal(fixed.project.installPolicy, "if-missing");
  assert.equal(fixed.wallet.installPolicy, "if-missing");
  assert.equal(broken.scenarios[0]?.resolvedFlow, BROKEN_FLOW);
  assert.equal(fixed.scenarios[0]?.resolvedFlow, FIXED_FLOW);
});

test("variant flows differ only by deep link and assert the same healthy recovery", async () => {
  const [broken, fixed] = await Promise.all([readFile(BROKEN_FLOW, "utf8"), readFile(FIXED_FLOW, "utf8")]);
  const normalizedBroken = broken.replace("variant=broken", "variant=VARIANT");
  const normalizedFixed = fixed.replace("variant=fixed", "variant=VARIANT");

  assert.equal(normalizedBroken, normalizedFixed);
  assert.match(broken, /launchrig:\/\/fixture\/rejection\?variant=broken/);
  assert.match(fixed, /launchrig:\/\/fixture\/rejection\?variant=fixed/);
  for (const source of [broken, fixed]) {
    assert.match(
      source,
      /id: "request-rejection"[\s\S]*when:\n\s+visible:\n\s+id: "com\.solana\.mwallet:id\/btn_connect"[\s\S]*commands:/,
    );
    assert.match(source, /id: "request-pending"[\s\S]*text: "\^false\$"/);
    assert.match(source, /id: "rejection-recovered"[\s\S]*text: "\^USER_REJECTED\$"/);
    assert.match(source, /id: "request-action-enabled"[\s\S]*text: "\^true\$"/);
    const documents = parseAllDocuments(source);
    assert.equal(documents.length, 2);
    assert.deepEqual(documents.flatMap((document) => document.errors), []);
  }
});

test("matrix preflight binds flows and verified APK hashes to relative evidence", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const brokenOutput = outputFor(workspace, "broken");
  const fixedOutput = outputFor(workspace, "fixed");
  const calls: Array<{ configPath: string; scenarioId: string | undefined }> = [];
  const result = await runFixtureMatrix({
    cwd: workspace.root,
    projectRunner: fakeProjectRunner(workspace, brokenOutput, fixedOutput, calls),
  });

  assert.deepEqual(calls, [
    { configPath: workspace.brokenConfig, scenarioId: SCENARIO_ID },
    { configPath: workspace.fixedConfig, scenarioId: SCENARIO_ID },
  ]);
  assert.equal(result.manifestPath, "fixtures/launchrig-matrix.v1.json");
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.provenance.app.sha256, workspace.appSha256);
  assert.equal(result.provenance.wallet.sha256, workspace.walletSha256);
  assert.equal(result.provenance.app.artifactPath, ".launchrig/cache/apks/controlled-app.apk");
  assert.equal(result.provenance.wallet.artifactPath, ".launchrig/cache/apks/mock-wallet.apk");
  assert.equal(result.provenance.variants.broken.launchUri, BROKEN_URI);
  assert.equal(result.provenance.variants.fixed.launchUri, FIXED_URI);
  assert.equal(result.provenance.variants.broken.configSha256, sha256(await readFile(workspace.brokenConfig)));
  assert.equal(
    result.provenance.variants.fixed.flowSha256,
    sha256(await readFile(path.join(workspace.root, "launchrig-flows", "fixture-rejection-fixed.yaml"))),
  );
  assert.equal(result.executions[0]?.configPath, "launchrig-fixture-broken.yml");
  assert.equal(result.executions[1]?.configPath, "launchrig-fixture-fixed.yml");
  assert.notStrictEqual(result.executions[0]?.output.report, brokenOutput.report);
  assert.notStrictEqual(result.executions[1]?.output.report, fixedOutput.report);
  assert.deepEqual(result.executions[0]?.output.report, brokenOutput.report);
  assert.deepEqual(result.executions[1]?.output.report, fixedOutput.report);
  assert.equal(result.executions[0]?.output.artifacts.json, "results/broken/fixture-run/launchrig-report.json");
  assert.equal(brokenOutput.artifacts.json, path.join(workspace.root, "results/broken/fixture-run/launchrig-report.json"));
  assert.equal(result.executions[0]?.output.report.outcome, "failed");
  assert.equal(result.executions[0]?.output.exitCode, 1);
  assert.equal(result.executions[1]?.output.report.outcome, "passed");
  assert.equal(result.executions[1]?.output.exitCode, 0);
  assert.equal(result.evaluation.accepted, true);
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(escapeRegex(workspace.root)));
});

test("matrix preflight rejects a flow that does not launch its manifest URI", async (context) => {
  const workspace = await createMatrixWorkspace(context, { brokenFlowUri: FIXED_URI });
  let calls = 0;
  await assert.rejects(
    runFixtureMatrix({
      cwd: workspace.root,
      projectRunner: async () => {
        calls += 1;
        return outputFor(workspace, "fixed");
      },
    }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError &&
      error.issues.some((issue) => issue.includes("exactly one openLink for " + BROKEN_URI)),
  );
  assert.equal(calls, 0);
});

test("matrix preflight rejects a cached APK that differs from tracked provenance", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  await writeFile(workspace.appArtifact, "tampered fixture APK");
  await assert.rejects(
    runFixtureMatrix({
      cwd: workspace.root,
      projectRunner: async () => outputFor(workspace, "fixed"),
    }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError &&
      error.issues.some((issue) => issue.includes("app fixture APK")),
  );
});

test("matrix preflight rejects configs that do not reinstall the exact broken pair", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const source = await readFile(workspace.brokenConfig, "utf8");
  await writeFile(workspace.brokenConfig, source.replaceAll("installPolicy: always", "installPolicy: if-missing"));
  await assert.rejects(
    runFixtureMatrix({
      cwd: workspace.root,
      projectRunner: async () => outputFor(workspace, "fixed"),
    }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError &&
      error.issues.some((issue) => issue.includes("broken project install must be true with installPolicy always")) &&
      error.issues.some((issue) => issue.includes("broken wallet install must be true with installPolicy always")),
  );
});

test("matrix preflight rejects alternate config paths and nonphysical profiles", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const alternateConfig = path.join(workspace.root, "alternate-broken.yml");
  await writeFile(alternateConfig, await readFile(workspace.brokenConfig));
  await assert.rejects(
    runFixtureMatrix({
      cwd: workspace.root,
      brokenConfigPath: alternateConfig,
      projectRunner: async () => outputFor(workspace, "fixed"),
    }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError &&
      error.issues.some((issue) => issue.includes("must use " + path.basename(workspace.brokenConfig))),
  );

  const source = await readFile(workspace.brokenConfig, "utf8");
  await writeFile(workspace.brokenConfig, source.replace("requirePhysical: true", "requirePhysical: false"));
  await assert.rejects(
    runFixtureMatrix({
      cwd: workspace.root,
      projectRunner: async () => outputFor(workspace, "fixed"),
    }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError &&
      error.issues.some((issue) => issue.includes("must require a physical Android device")),
  );
});

test("matrix preflight rejects a changed canonical flow even when its launch URI remains valid", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const brokenFlow = path.join(workspace.root, "launchrig-flows", "fixture-rejection-broken.yaml");
  await writeFile(brokenFlow, (await readFile(brokenFlow, "utf8")) + "# changed after review\n");
  await assert.rejects(
    runFixtureMatrix({
      cwd: workspace.root,
      projectRunner: async () => outputFor(workspace, "fixed"),
    }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError &&
      error.issues.some((issue) => issue.includes("flow SHA-256 differs")),
  );
});

test("matrix preflight rejects a canonical flow symlink that escapes the workspace", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const externalDirectory = await mkdtemp(path.join(tmpdir(), "launchrig-external-flow-"));
  context.after(async () => await rm(externalDirectory, { recursive: true, force: true }));
  const brokenFlow = path.join(workspace.root, "launchrig-flows", "fixture-rejection-broken.yaml");
  const externalFlow = path.join(externalDirectory, "fixture-rejection-broken.yaml");
  await writeFile(externalFlow, await readFile(brokenFlow));
  await rm(brokenFlow);
  await symlink(externalFlow, brokenFlow);

  await assert.rejects(
    runFixtureMatrix({
      cwd: workspace.root,
      projectRunner: async () => outputFor(workspace, "fixed"),
    }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError &&
      error.issues.some((issue) => issue.includes("resolves outside the LaunchRig workspace")),
  );
});

test("matrix rejects missing, emulated, and wrong-version execution evidence", async (context) => {
  const cases = [
    {
      name: "missing device",
      mutate: (output: RunOutput) => {
        delete output.report.device;
      },
      expected: "physical-device evidence is missing",
    },
    {
      name: "emulator",
      mutate: (output: RunOutput) => {
        assert.ok(output.report.device);
        output.report.device.isEmulator = true;
      },
      expected: "must come from a physical Android device",
    },
    {
      name: "wrong app version",
      mutate: (output: RunOutput) => {
        output.report.app.versionCode = "999";
      },
      expected: "app package versionCode must be 1",
    },
  ];

  for (const evidenceCase of cases) {
    await context.test(evidenceCase.name, async (subcontext) => {
      const workspace = await createMatrixWorkspace(subcontext);
      const brokenOutput = outputFor(workspace, "broken");
      const fixedOutput = outputFor(workspace, "fixed");
      evidenceCase.mutate(fixedOutput);
      await assert.rejects(
        runFixtureMatrix({
          cwd: workspace.root,
          projectRunner: fakeProjectRunner(workspace, brokenOutput, fixedOutput, []),
        }),
        (error: unknown) =>
          error instanceof FixtureMatrixValidationError &&
          error.issues.some((issue) => issue.includes(evidenceCase.expected)),
      );
    });
  }
});

test("missing cached matrix artifacts retain environment exit code three", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  await rm(workspace.appArtifact);
  const dependency = async (options: RunFixtureMatrixOptions = {}): Promise<RunFixtureMatrixOutput> =>
    await runFixtureMatrix({
      ...options,
      cwd: workspace.root,
      projectRunner: async () => outputFor(workspace, "fixed"),
    });
  await assert.rejects(
    dependency(),
    (error: unknown) =>
      error instanceof FixtureMatrixEnvironmentError &&
      error.issues.some((issue) => issue.includes("Cannot verify app fixture APK")),
  );
  const capture = captureIO();
  assert.equal(await runCli(["matrix"], capture.io, { runFixtureMatrix: dependency }), 3);
  assert.match(capture.errors[0] ?? "", /Fixture matrix environment error/);
});

test("matrix detects a fixture APK mutation that happens during execution", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  let calls = 0;
  await assert.rejects(
    runFixtureMatrix({
      cwd: workspace.root,
      projectRunner: async () => {
        calls += 1;
        if (calls === 2) await writeFile(workspace.appArtifact, "mutated during execution");
        return outputFor(workspace, calls === 1 ? "broken" : "fixed");
      },
    }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError &&
      error.issues.some((issue) => issue.includes("app fixture APK")),
  );
  assert.equal(calls, 2);
});

test("matrix setup errors retain environment exit code three", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const brokenOutput = outputFor(workspace, "broken");
  brokenOutput.report.outcome = "setup-error";
  brokenOutput.exitCode = 3;
  delete brokenOutput.report.device;
  delete brokenOutput.report.wallet;
  brokenOutput.report.checks = [
    {
      id: "tool.adb",
      name: "ADB available",
      status: "fail",
      required: true,
      durationMs: 1,
      summary: "ADB is unavailable",
    },
  ];
  const fixedOutput = outputFor(workspace, "fixed");
  const calls: Array<{ configPath: string; scenarioId: string | undefined }> = [];
  const result = await runFixtureMatrix({
    cwd: workspace.root,
    projectRunner: fakeProjectRunner(workspace, brokenOutput, fixedOutput, calls),
  });

  assert.equal(calls.length, 2);
  assert.equal(result.evaluation.accepted, false);
  assert.ok(result.evaluation.issues.some((issue) => issue.code === "setup-error"));
  assert.equal(result.exitCode, 3);
  const capture = captureIO();
  assert.equal(
    await runCli(["matrix"], capture.io, {
      runFixtureMatrix: async () => result,
    }),
    3,
  );
});

test("matrix CLI exposes sanitized relative JSON evidence", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const brokenOutput = outputFor(workspace, "broken");
  const fixedOutput = outputFor(workspace, "fixed");
  const privateDetail = "/Users/alice/private/device.log";
  const brokenCheck = brokenOutput.report.checks[0];
  if (brokenCheck) brokenCheck.details = privateDetail;
  let received: RunFixtureMatrixOptions | undefined;
  const dependency = async (options: RunFixtureMatrixOptions = {}): Promise<RunFixtureMatrixOutput> => {
    received = options;
    return await runFixtureMatrix({
      ...options,
      cwd: workspace.root,
      projectRunner: fakeProjectRunner(workspace, brokenOutput, fixedOutput, []),
    });
  };
  const capture = captureIO();
  const exitCode = await runCli(
    [
      "matrix",
      "--device",
      "TEST-DEVICE",
      "--json",
    ],
    capture.io,
    { runFixtureMatrix: dependency },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(received, {
    deviceSerial: "TEST-DEVICE",
  });
  assert.deepEqual(capture.errors, []);
  assert.doesNotMatch(capture.output[0] ?? "", new RegExp(escapeRegex(workspace.root)));
  assert.doesNotMatch(capture.output[0] ?? "", /\/Users\/alice/);
  assert.equal(brokenOutput.report.checks[0]?.details, privateDetail);
  const rendered = JSON.parse(capture.output[0] ?? "") as RunFixtureMatrixOutput;
  assert.equal(rendered.provenance.app.sha256, workspace.appSha256);
  assert.equal(rendered.provenance.wallet.sha256, workspace.walletSha256);
  assert.equal(rendered.executions[0]?.output.report.outcome, "failed");
  assert.equal(rendered.executions[0]?.output.exitCode, 1);
  assert.equal(rendered.executions[1]?.output.report.outcome, "passed");
  assert.equal(rendered.executions[1]?.output.exitCode, 0);
});

test("matrix CLI cannot return zero for a rejected pair and help documents the command", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const brokenOutput = outputFor(workspace, "broken");
  const fixedOutput = outputFor(workspace, "fixed");
  fixedOutput.exitCode = 1;
  const rejected = await runFixtureMatrix({
    cwd: workspace.root,
    projectRunner: fakeProjectRunner(workspace, brokenOutput, fixedOutput, []),
  });
  const capture = captureIO();
  const exitCode = await runCli(["matrix"], capture.io, {
    runFixtureMatrix: async () => rejected,
  });
  assert.equal(exitCode, 1);
  assert.match(capture.output[0] ?? "", /LaunchRig fixture matrix: rejected/);
  assert.match(capture.output[0] ?? "", /app SHA-256: [a-f0-9]{64}/);

  const help = captureIO();
  assert.equal(await runCli(["--help"], help.io), 0);
  assert.match(help.output[0] ?? "", /launchrig matrix/);
  assert.doesNotMatch(help.output[0] ?? "", /--broken-config/);
});
