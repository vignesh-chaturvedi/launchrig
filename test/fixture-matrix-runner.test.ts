import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { parseAllDocuments } from "yaml";
import { runCli, type CliIO } from "../src/cli.js";
import {
  CONTROLLED_CASES,
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
const APP_PACKAGE = "dev.launchrig.fixture";
const WALLET_PACKAGE = "com.solana.mwallet";
const VARIANTS: readonly FixtureMatrixVariant[] = ["broken", "fixed"];

interface MatrixCaseContract {
  id: string;
  name: string;
  kind: "mwa-reject" | "mwa-stale-authorization" | "mwa-process-death";
  flowStem: string;
  route: string;
  marker: string;
  openLinkCount: number;
  processDeath: boolean;
}

const CASES: readonly MatrixCaseContract[] = [
  {
    id: "rejection-recovery",
    name: "Wallet rejection recovery",
    kind: "mwa-reject",
    flowStem: "rejection",
    route: "rejection",
    marker: "id: request-pending",
    openLinkCount: 1,
    processDeath: false,
  },
  {
    id: "stale-authorization-recovery",
    name: "Stale authorization recovery",
    kind: "mwa-stale-authorization",
    flowStem: "stale-authorization",
    route: "stale-authorization",
    marker: "id: reauthorization-pending",
    openLinkCount: 1,
    processDeath: false,
  },
  {
    id: "process-death-recovery",
    name: "Process-death recovery",
    kind: "mwa-process-death",
    flowStem: "process-death",
    route: "process-death",
    marker: "id: process-death-state",
    openLinkCount: 2,
    processDeath: true,
  },
];

interface MatrixWorkspace {
  root: string;
  appArtifact: string;
  appSha256: string;
  walletSha256: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function configName(matrixCase: MatrixCaseContract, variant: FixtureMatrixVariant): string {
  return "launchrig-fixture-" + matrixCase.flowStem + "-" + variant + ".yml";
}

function flowName(matrixCase: MatrixCaseContract, variant: FixtureMatrixVariant): string {
  return "fixture-" + matrixCase.flowStem + "-" + variant + ".yaml";
}

function launchUri(matrixCase: MatrixCaseContract, variant: FixtureMatrixVariant): string {
  return "launchrig://fixture/" + matrixCase.route + "?variant=" + variant;
}

function flowSource(
  matrixCase: MatrixCaseContract,
  variant: FixtureMatrixVariant,
  options: { includeKill?: boolean; includeStop?: boolean } = {},
): string {
  const uri = launchUri(matrixCase, variant);
  const lines = [
    "appId: " + APP_PACKAGE,
    "name: " + matrixCase.name,
    "---",
    "- openLink:",
    '    link: "' + uri + '"',
    "- assertVisible:",
    '    id: "fixture-variant"',
    '    text: "^' + variant + '$"',
  ];
  if (options.includeKill) {
    lines.push("- killApp:", "    appId: " + APP_PACKAGE);
  }
  if (matrixCase.processDeath && options.includeStop !== false) lines.push("- stopApp: " + APP_PACKAGE);
  if (matrixCase.openLinkCount === 2) {
    lines.push("- openLink:", '    link: "' + uri + '"');
  }
  return lines.join("\n") + "\n";
}

function configSource(
  matrixCase: MatrixCaseContract,
  variant: FixtureMatrixVariant,
  appArtifactName: string,
  walletArtifactName: string,
): string {
  const firstRun = matrixCase.id === CASES[0]?.id && variant === "broken";
  const policy = firstRun ? "always" : "if-missing";
  const timeout = matrixCase.processDeath ? 150000 : 120000;
  return [
    "version: 1",
    "project:",
    '  name: "Fixture ' + matrixCase.id + " " + variant + '"',
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
    "  - id: " + matrixCase.id,
    "    kind: " + matrixCase.kind,
    '    name: "' + matrixCase.name + '"',
    "    flow: ./launchrig-flows/" + flowName(matrixCase, variant),
    "    required: true",
    "    timeoutMs: " + timeout,
    "artifacts:",
    "  directory: ./.launchrig/results/fixture-matrix/" + matrixCase.id + "/" + variant,
    "  screenshots: failure",
    "  retention: 5",
    "privacy:",
    "  includeLogcat: false",
    "  logcatLines: 200",
    "  redactPatterns: []",
    "tooling:",
    "  maestro: ./.launchrig/tools/maestro-2.8.0/maestro/bin/maestro",
    "",
  ].join("\n");
}

async function createMatrixWorkspace(context: TestContext): Promise<MatrixWorkspace> {
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
  const deepLinks: Record<string, Record<FixtureMatrixVariant, string>> = {};
  const manifestCases = [];
  const writes: Array<Promise<void>> = [];

  for (const matrixCase of CASES) {
    deepLinks[matrixCase.id] = {
      broken: launchUri(matrixCase, "broken"),
      fixed: launchUri(matrixCase, "fixed"),
    };
    const expectations: Record<string, unknown> = {};
    for (const variant of VARIANTS) {
      const flow = flowSource(matrixCase, variant);
      const config = configSource(matrixCase, variant, appArtifactName, walletArtifactName);
      writes.push(
        writeFile(path.join(flowsDirectory, flowName(matrixCase, variant)), flow),
        writeFile(path.join(root, configName(matrixCase, variant)), config),
      );
      expectations[variant] = {
        launchUri: launchUri(matrixCase, variant),
        configSha256: sha256(config),
        flowSha256: sha256(flow),
        scenarioStatus: variant === "broken" ? "fail" : "pass",
        outcome: variant === "broken" ? "failed" : "passed",
        exitCode: variant === "broken" ? 1 : 0,
      };
    }
    manifestCases.push({ id: matrixCase.id, name: matrixCase.name, scenarioId: matrixCase.id, expectations });
  }

  const appManifest = {
    schemaVersion: 1,
    packageName: APP_PACKAGE,
    versionName: "0.2.0",
    versionCode: 2,
    network: "devnet",
    deepLinks,
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
  writes.push(
    writeFile(
      path.join(fixturesDirectory, "launchrig-matrix.v1.json"),
      JSON.stringify({ schemaVersion: 1, cases: manifestCases }),
    ),
    writeFile(path.join(fixturesDirectory, "launchrig-dapp-v0.2.0.json"), JSON.stringify(appManifest)),
    writeFile(path.join(fixturesDirectory, "mock-mwa-main.json"), JSON.stringify(walletManifest)),
    writeFile(appArtifact, appBytes),
    writeFile(walletArtifact, walletBytes),
  );
  await Promise.all(writes);
  return { root, appArtifact, appSha256, walletSha256 };
}

function contractForConfig(configPath: string): { matrixCase: MatrixCaseContract; variant: FixtureMatrixVariant } {
  for (const matrixCase of CASES) {
    for (const variant of VARIANTS) {
      if (path.basename(configPath) === configName(matrixCase, variant)) return { matrixCase, variant };
    }
  }
  throw new Error("Unexpected config path " + configPath);
}

function outputFor(
  workspace: MatrixWorkspace,
  matrixCase: MatrixCaseContract,
  variant: FixtureMatrixVariant,
): RunOutput {
  const broken = variant === "broken";
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
    runId: matrixCase.id + "-" + variant,
    project: "Fixture " + matrixCase.id + " " + variant,
    packageName: APP_PACKAGE,
    network: "devnet",
    startedAt: new Date("2026-08-25T12:00:00.000Z"),
    completedAt: new Date("2026-08-25T12:00:01.000Z"),
    checks: [
      ...evidenceChecks,
      {
        id: "scenario." + matrixCase.id,
        name: matrixCase.name,
        status: broken ? "fail" : "pass",
        required: true,
        durationMs: 1000,
        summary: broken ? "Controlled assertion failed" : "Recovery assertions passed",
        ...(broken ? { details: "Assertion is false: controlled target, " + matrixCase.marker + " is visible" } : {}),
      },
    ],
    device: {
      serial: "***TEST",
      manufacturer: "LaunchRig",
      model: "Physical fixture",
      androidVersion: "12",
      apiLevel: 31,
      abi: "arm64-v8a",
      securityPatch: "2026-08-01",
      isEmulator: false,
    },
    app: { packageName: APP_PACKAGE, versionName: "0.2.0", versionCode: "2" },
    wallet: { packageName: WALLET_PACKAGE, versionName: "1.0.1", versionCode: "2" },
  });
  const directory = path.join(
    workspace.root,
    ".launchrig",
    "results",
    "fixture-matrix",
    matrixCase.id,
    variant,
    "fixture-run",
  );
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
  calls: Array<{ configPath: string; scenarioId: string | undefined }> = [],
  mutate?: (
    output: RunOutput,
    matrixCase: MatrixCaseContract,
    variant: FixtureMatrixVariant,
  ) => void | Promise<void>,
): FixtureMatrixProjectRunner {
  return async (configPath, options = {}) => {
    const contract = contractForConfig(configPath);
    const output = outputFor(workspace, contract.matrixCase, contract.variant);
    await mutate?.(output, contract.matrixCase, contract.variant);
    calls.push({ configPath, scenarioId: options.scenarioId });
    return output;
  };
}

async function refreshFlowHash(
  workspace: MatrixWorkspace,
  matrixCase: MatrixCaseContract,
  variant: FixtureMatrixVariant,
): Promise<void> {
  const manifestPath = path.join(workspace.root, "fixtures", "launchrig-matrix.v1.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    cases: Array<{ id: string; expectations: Record<FixtureMatrixVariant, { flowSha256: string }> }>;
  };
  const entry = manifest.cases.find((candidate) => candidate.id === matrixCase.id);
  assert.ok(entry);
  const flow = await readFile(path.join(workspace.root, "launchrig-flows", flowName(matrixCase, variant)));
  entry.expectations[variant].flowSha256 = sha256(flow);
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, cases: manifest.cases }));
}

function captureIO(): { io: CliIO; output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: { out: (message) => output.push(message), error: (message) => errors.push(message) },
    output,
    errors,
  };
}

test("tracked lifecycle configs and flows match the six-run contract", async () => {
  assert.deepEqual(CONTROLLED_CASES.map((entry) => entry.id), CASES.map((entry) => entry.id));
  for (const [caseIndex, matrixCase] of CASES.entries()) {
    const sources: Record<FixtureMatrixVariant, string> = { broken: "", fixed: "" };
    for (const variant of VARIANTS) {
      const config = await loadConfig(path.join(WORKSPACE, configName(matrixCase, variant)));
      assert.equal(config.scenarios[0]?.kind, matrixCase.kind);
      assert.equal(
        config.resolvedArtifactDirectory,
        path.join(WORKSPACE, ".launchrig", "results", "fixture-matrix", matrixCase.id, variant),
      );
      assert.equal(config.project.installPolicy, caseIndex === 0 && variant === "broken" ? "always" : "if-missing");
      sources[variant] = await readFile(path.join(WORKSPACE, "launchrig-flows", flowName(matrixCase, variant)), "utf8");
      const documents = parseAllDocuments(sources[variant]);
      assert.equal(documents.length, 2);
      assert.deepEqual(documents.flatMap((document) => document.errors), []);
    }
    const normalizedBroken = sources.broken
      .replaceAll(launchUri(matrixCase, "broken"), "URI")
      .replace('text: "^broken$"', 'text: "^VARIANT$"');
    const normalizedFixed = sources.fixed
      .replaceAll(launchUri(matrixCase, "fixed"), "URI")
      .replace('text: "^fixed$"', 'text: "^VARIANT$"');
    assert.equal(normalizedBroken, normalizedFixed);
    assert.equal((sources.broken.match(/- openLink:/g) ?? []).length, matrixCase.openLinkCount);
    assert.equal((sources.broken.match(/- stopApp:/g) ?? []).length, matrixCase.processDeath ? 1 : 0);
    assert.equal((sources.broken.match(/- killApp:/g) ?? []).length, 0);
  }
});

test("matrix executes three red and green pairs in canonical order", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const calls: Array<{ configPath: string; scenarioId: string | undefined }> = [];
  const result = await runFixtureMatrix({ cwd: workspace.root, projectRunner: fakeProjectRunner(workspace, calls) });

  assert.deepEqual(
    calls.map((call) => [path.basename(call.configPath), call.scenarioId]),
    CASES.flatMap((matrixCase) => VARIANTS.map((variant) => [configName(matrixCase, variant), matrixCase.id])),
  );
  assert.equal(result.executions.length, 6);
  assert.equal(result.provenance.cases.length, 3);
  assert.equal(result.provenance.app.sha256, workspace.appSha256);
  assert.equal(result.provenance.wallet.sha256, workspace.walletSha256);
  assert.equal(result.provenance.cases[2]?.variants.fixed.launchUri, launchUri(CASES[2]!, "fixed"));
  assert.equal(result.evaluation.accepted, true);
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(workspace.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("matrix rejects missing or reordered controlled cases", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const manifestPath = path.join(workspace.root, "fixtures", "launchrig-matrix.v1.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { schemaVersion: 1; cases: unknown[] };
  manifest.cases.reverse();
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    runFixtureMatrix({ cwd: workspace.root, projectRunner: fakeProjectRunner(workspace) }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError && error.issues.some((issue) => issue.includes("case 0 must be")),
  );
});

test("matrix rejects process-death flows without an explicit package-scoped stop", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const matrixCase = CASES[2]!;
  const flowPath = path.join(workspace.root, "launchrig-flows", flowName(matrixCase, "broken"));
  await writeFile(flowPath, flowSource(matrixCase, "broken", { includeStop: false }));
  await refreshFlowHash(workspace, matrixCase, "broken");
  await assert.rejects(
    runFixtureMatrix({ cwd: workspace.root, projectRunner: fakeProjectRunner(workspace) }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError &&
      error.issues.some((issue) => issue.includes("exactly one stopApp targeting " + APP_PACKAGE)),
  );
});

test("matrix rejects nondeterministic killApp fallback even when the hash is updated", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const matrixCase = CASES[2]!;
  const flowPath = path.join(workspace.root, "launchrig-flows", flowName(matrixCase, "fixed"));
  await writeFile(flowPath, flowSource(matrixCase, "fixed", { includeKill: true }));
  await refreshFlowHash(workspace, matrixCase, "fixed");
  await assert.rejects(
    runFixtureMatrix({ cwd: workspace.root, projectRunner: fakeProjectRunner(workspace) }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError && error.issues.some((issue) => issue.includes("must not contain killApp")),
  );
});

test("matrix rejects changed paired flows and artifact mutations", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const matrixCase = CASES[1]!;
  const flowPath = path.join(workspace.root, "launchrig-flows", flowName(matrixCase, "fixed"));
  await writeFile(flowPath, (await readFile(flowPath, "utf8")) + "# reviewed difference\n");
  await refreshFlowHash(workspace, matrixCase, "fixed");
  await assert.rejects(
    runFixtureMatrix({ cwd: workspace.root, projectRunner: fakeProjectRunner(workspace) }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError && error.issues.some((issue) => issue.includes("must be identical")),
  );

  await writeFile(flowPath, flowSource(matrixCase, "fixed"));
  await refreshFlowHash(workspace, matrixCase, "fixed");
  await writeFile(workspace.appArtifact, "tampered fixture APK");
  await assert.rejects(
    runFixtureMatrix({ cwd: workspace.root, projectRunner: fakeProjectRunner(workspace) }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError && error.issues.some((issue) => issue.includes("app fixture APK")),
  );
});

test("matrix rejects a config mutated during a controlled run", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const firstCase = CASES[0]!;
  const configPath = path.join(workspace.root, configName(firstCase, "broken"));

  await assert.rejects(
    runFixtureMatrix({
      cwd: workspace.root,
      projectRunner: fakeProjectRunner(workspace, [], async (_output, matrixCase, variant) => {
        if (matrixCase.id === firstCase.id && variant === "broken") {
          await writeFile(configPath, (await readFile(configPath, "utf8")) + "# mutation during run\n");
        }
      }),
    }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError &&
      error.issues.some((issue) =>
        issue.includes(firstCase.id + " broken config changed after controlled matrix preflight after"),
      ),
  );
});

test("matrix rejects a flow mutated during a controlled run", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const firstCase = CASES[0]!;
  const flowPath = path.join(workspace.root, "launchrig-flows", flowName(firstCase, "broken"));

  await assert.rejects(
    runFixtureMatrix({
      cwd: workspace.root,
      projectRunner: fakeProjectRunner(workspace, [], async (_output, matrixCase, variant) => {
        if (matrixCase.id === firstCase.id && variant === "broken") {
          await writeFile(flowPath, (await readFile(flowPath, "utf8")) + "# mutation during run\n");
        }
      }),
    }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError &&
      error.issues.some((issue) =>
        issue.includes(firstCase.id + " broken Maestro flow changed after controlled matrix preflight after"),
      ),
  );
});

test("matrix rejects alternate paths and escaping flow symlinks", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  await assert.rejects(
    runFixtureMatrix({
      cwd: workspace.root,
      brokenConfigPath: path.join(workspace.root, "alternate.yml"),
      projectRunner: fakeProjectRunner(workspace),
    }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError && error.issues.some((issue) => issue.includes("alternate config")),
  );

  const matrixCase = CASES[0]!;
  const flowPath = path.join(workspace.root, "launchrig-flows", flowName(matrixCase, "broken"));
  const externalDirectory = await mkdtemp(path.join(tmpdir(), "launchrig-external-flow-"));
  context.after(async () => await rm(externalDirectory, { recursive: true, force: true }));
  const externalFlow = path.join(externalDirectory, "flow.yaml");
  await writeFile(externalFlow, await readFile(flowPath));
  await rm(flowPath);
  await symlink(externalFlow, flowPath);
  await assert.rejects(
    runFixtureMatrix({ cwd: workspace.root, projectRunner: fakeProjectRunner(workspace) }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError &&
      error.issues.some((issue) => issue.includes("resolves outside the LaunchRig workspace")),
  );
});

test("matrix requires each broken run to fail at its controlled marker", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  await assert.rejects(
    runFixtureMatrix({
      cwd: workspace.root,
      projectRunner: fakeProjectRunner(workspace, [], (output, matrixCase, variant) => {
        if (matrixCase.id === CASES[1]?.id && variant === "broken") {
          const target = output.report.checks.find((check) => check.id === "scenario." + matrixCase.id);
          assert.ok(target);
          target.details = "Assertion is false: id: fixture-ready";
        }
      }),
    }),
    (error: unknown) =>
      error instanceof FixtureMatrixValidationError &&
      error.issues.some((issue) => issue.includes("id: reauthorization-pending")),
  );
});

test("matrix preserves setup-error exit code and missing-artifact environment errors", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  const result = await runFixtureMatrix({
    cwd: workspace.root,
    projectRunner: fakeProjectRunner(workspace, [], (output, matrixCase, variant) => {
      if (matrixCase.id === CASES[0]?.id && variant === "broken") {
        output.report.outcome = "setup-error";
        output.exitCode = 3;
      }
    }),
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.evaluation.accepted, false);

  await rm(workspace.appArtifact);
  await assert.rejects(
    runFixtureMatrix({ cwd: workspace.root, projectRunner: fakeProjectRunner(workspace) }),
    (error: unknown) =>
      error instanceof FixtureMatrixEnvironmentError &&
      error.issues.some((issue) => issue.includes("Cannot verify app fixture APK")),
  );
});

test("matrix CLI returns sanitized six-run JSON evidence", async (context) => {
  const workspace = await createMatrixWorkspace(context);
  let received: RunFixtureMatrixOptions | undefined;
  const dependency = async (options: RunFixtureMatrixOptions = {}): Promise<RunFixtureMatrixOutput> => {
    received = options;
    return await runFixtureMatrix({ ...options, cwd: workspace.root, projectRunner: fakeProjectRunner(workspace) });
  };
  const capture = captureIO();
  const exitCode = await runCli(["matrix", "--device", "TEST-DEVICE", "--json"], capture.io, {
    runFixtureMatrix: dependency,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(received, { deviceSerial: "TEST-DEVICE" });
  assert.deepEqual(capture.errors, []);
  const rendered = JSON.parse(capture.output[0] ?? "") as RunFixtureMatrixOutput;
  assert.equal(rendered.executions.length, 6);
  assert.equal(rendered.provenance.cases.length, 3);
  assert.doesNotMatch(capture.output[0] ?? "", new RegExp(workspace.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const help = captureIO();
  assert.equal(await runCli(["--help"], help.io), 0);
  assert.match(help.output[0] ?? "", /launchrig matrix/);
});
