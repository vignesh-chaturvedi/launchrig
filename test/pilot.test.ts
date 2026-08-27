import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkPilot,
  exportPilotEvidence,
  getPilotStatus,
  pilotMetrics,
  pilotTechnicalGate,
  PilotError,
  runPilot,
  startPilot,
} from "../src/commands/pilot.js";
import type { DoctorOutput } from "../src/commands/doctor.js";
import { runCli } from "../src/cli.js";
import { loadConfig } from "../src/config/load.js";
import { verifyPublicPilotEvidence } from "../src/pilot/public-evidence.js";
import { readPilotState, sha256Value } from "../src/pilot/store.js";
import type { PilotProjectRunner, PilotRunEvidenceV1, PilotStateCoreV1 } from "../src/pilot/types.js";
import type { LaunchRigReport } from "../src/types.js";

async function writePublisherProject(directory: string, packageName = "com.publisher.mobile"): Promise<string> {
  await writeFile(
    path.join(directory, "authorize.yaml"),
    [
      "appId: " + packageName,
      "---",
      "- launchApp:",
      "    clearState: false",
      "- assertVisible: Connect",
      "",
    ].join("\n"),
    "utf8",
  );
  const configPath = path.join(directory, "launchrig.yml");
  await writeFile(
    configPath,
    [
      "version: 1",
      "project:",
      "  name: Publisher Mobile",
      "  packageName: " + packageName,
      "  install: false",
      "target:",
      "  network: devnet",
      "device:",
      "  requirePhysical: true",
      "  minimumApiLevel: 26",
      "wallet:",
      "  mode: mock-mwa",
      "  packageName: com.solana.mwallet",
      "  install: false",
      "scenarios:",
      "  - id: authorize",
      "    kind: mwa-authorize",
      "    name: Authorize",
      "    flow: ./authorize.yaml",
      "artifacts:",
      "  directory: ./.launchrig/results",
      "  screenshots: failure",
      "  retention: 5",
      "privacy:",
      "  includeLogcat: false",
      "  logcatLines: 200",
      "  redactPatterns: []",
      "tooling: {}",
      "",
    ].join("\n"),
    "utf8",
  );
  return configPath;
}

async function writeFullPublisherProject(directory: string): Promise<string> {
  const configPath = await writePublisherProject(directory);
  const scenarios = [
    ["authorize", "mwa-authorize", "Authorize"],
    ["siws", "mwa-siws", "Sign in with Solana"],
    ["sign-message", "mwa-sign-message", "Sign message"],
    ["reject", "mwa-reject", "Reject and recover"],
  ] as const;
  for (const [id] of scenarios) {
    await writeFile(
      path.join(directory, id + ".yaml"),
      "appId: com.publisher.mobile\n---\n- launchApp:\n    clearState: false\n- assertVisible:\n    id: publisher-" +
        id +
        "-ready\n",
      "utf8",
    );
  }
  const source = await readFile(configPath, "utf8");
  const scenarioSource = [
    "scenarios:",
    ...scenarios.flatMap(([id, kind, name]) => [
      "  - id: " + id,
      "    kind: " + kind,
      "    name: " + name,
      "    flow: ./" + id + ".yaml",
      "    required: true",
    ]),
    "artifacts:",
  ].join("\n");
  await writeFile(configPath, source.replace(/scenarios:\n[\s\S]*?artifacts:/, scenarioSource), "utf8");
  return configPath;
}

function passingRunner(
  directory: string,
  fixedRunId?: string,
  readiness: LaunchRigReport["readiness"] = "Android Device Ready",
  scenarioIds: readonly string[] = ["authorize"],
): PilotProjectRunner {
  let index = 0;
  return async () => {
    index += 1;
    const runId = fixedRunId ?? "publisher-run-" + index;
    const report: LaunchRigReport = {
      schemaVersion: 1,
      launchRigVersion: "0.1.0",
      runId,
      project: "Publisher Mobile",
      packageName: "com.publisher.mobile",
      network: "devnet",
      startedAt: "2026-08-26T10:00:00.000Z",
      completedAt: "2026-08-26T10:05:00.000Z",
      durationMs: 5 * 60 * 1000,
      outcome: "passed",
      readiness,
      app: { packageName: "com.publisher.mobile", versionName: "1.0.0", apkSha256: "a".repeat(64) },
      wallet: {
        packageName: "com.solana.mwallet",
        apkSha256: "b9b28b4936f388f615febc493e0af5c7e8c40002de4a3cddbef4f52315a9ef3b",
      },
      device: {
        serial: "***",
        manufacturer: "Publisher",
        model: "Phone",
        androidVersion: "16",
        apiLevel: 36,
        abi: "arm64-v8a",
        securityPatch: "2026-08-01",
        isEmulator: false,
      },
      checks: [
        ...[
          "tool.adb",
          "device.connected",
          "device.api",
          "app.installed",
          "app.binary",
          "tool.maestro",
          "wallet.installed",
          "wallet.binary",
        ].map((id) => ({
          id,
          name: id,
          status: "pass" as const,
          required: true,
          durationMs: 1,
          summary: "passed",
        })),
        ...scenarioIds.map((scenarioId) => ({
          id: "scenario." + scenarioId,
          name: scenarioId,
          status: "pass" as const,
          required: true,
          durationMs: 100,
          summary: "passed",
        })),
      ],
    };
    const resultDirectory = path.join(directory, "runner-results", runId);
    await mkdir(resultDirectory, { recursive: true });
    const json = path.join(resultDirectory, "launchrig-report.json");
    await writeFile(json, JSON.stringify(report, null, 2) + "\n", "utf8");
    return {
      report,
      artifacts: {
        directory: resultDirectory,
        json,
        html: path.join(resultDirectory, "launchrig-report.html"),
        junit: path.join(resultDirectory, "launchrig-junit.xml"),
        redactionCount: 0,
      },
      exitCode: 0,
    };
  };
}

function readyDoctorOutput(): DoctorOutput {
  return {
    ok: true,
    adb: { path: "/test/adb", version: "Android Debug Bridge 1.0.41" },
    maestro: { required: true, path: "/test/maestro", installed: true, version: "2.8.0" },
    device: {
      serial: "***1234",
      manufacturer: "Publisher",
      model: "Phone",
      androidVersion: "16",
      apiLevel: 36,
      abi: "arm64-v8a",
      securityPatch: "2026-08-01",
      isEmulator: false,
    },
    packages: [
      {
        packageName: "com.publisher.mobile",
        installed: true,
        willInstall: false,
        role: "app",
        installedSha256: "a".repeat(64),
        binaryReady: true,
      },
      {
        packageName: "com.solana.mwallet",
        installed: true,
        willInstall: false,
        role: "wallet",
        installedSha256: "b9b28b4936f388f615febc493e0af5c7e8c40002de4a3cddbef4f52315a9ef3b",
        expectedSha256: "b9b28b4936f388f615febc493e0af5c7e8c40002de4a3cddbef4f52315a9ef3b",
        binaryReady: true,
      },
    ],
    issues: [],
  };
}

test("pilot preflight is read-only and separates policy, technical, and external gates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-check-"));
  try {
    const configPath = await writeFullPublisherProject(directory);
    const pilotId = "publisher-preflight";
    const started = await startPilot({
      pilotId,
      configPath,
      now: () => new Date("2026-08-26T10:00:00.000Z"),
    });
    const stateBefore = await readFile(started.statePath, "utf8");
    const stateDirectories = [
      path.join(directory, ".launchrig"),
      path.join(directory, ".launchrig", "pilots"),
      path.dirname(started.statePath),
    ];
    const modesBefore = await Promise.all(
      stateDirectories.map(async (directoryPath) => (await lstat(directoryPath)).mode & 0o777),
    );
    let doctorCalls = 0;
    const runDoctor = async (options: Parameters<NonNullable<Parameters<typeof checkPilot>[0]["doctorRunner"]>>[0]) => {
      doctorCalls += 1;
      assert.equal(options.verifyInstalledArtifactHashes, true);
      return readyDoctorOutput();
    };
    const checked = await checkPilot({ pilotId, configPath, doctorRunner: runDoctor });
    assert.equal(checked.exitCode, 0);
    assert.equal(checked.readyToRecord, true);
    assert.equal(doctorCalls, 1);
    assert.ok(checked.checks.every((check) => check.status === "pass"));
    assert.equal(checked.technicalPilot.qualified, false);
    assert.equal(checked.externalGrantGate.grantReady, false);
    assert.deepEqual(checked.externalGrantGate, {
      status: "not-established",
      grantReady: false,
      publisherAttestation: "not-established",
      threeIndependentPublishers: "not-established",
      confirmedDefect: "not-established",
      seekerAttestation: "not-established",
      publicRelease: "not-established",
    });
    assert.equal(await readFile(started.statePath, "utf8"), stateBefore);
    assert.deepEqual(
      await Promise.all(
        stateDirectories.map(async (directoryPath) => (await lstat(directoryPath)).mode & 0o777),
      ),
      modesBefore,
    );

    const cliOutput: string[] = [];
    const cliErrors: string[] = [];
    assert.equal(
      await runCli(
        ["pilot", "check", "--pilot", pilotId, "--config", configPath, "--json"],
        { out: (message) => cliOutput.push(message), error: (message) => cliErrors.push(message) },
        {
          checkPilot: async (options) =>
            await checkPilot({ ...options, doctorRunner: async () => readyDoctorOutput() }),
        },
      ),
      0,
    );
    assert.equal(cliErrors.length, 0);
    assert.equal(JSON.parse(cliOutput.join("\n")).readyToRecord, true);
    assert.equal(await readFile(started.statePath, "utf8"), stateBefore);

    const rejectedArguments = [
      ["--scenario", "authorize"],
      ["--repeat", "3"],
      ["--force"],
      ["--output", "evidence.json"],
      ["--name", "Other"],
      ["--package", "com.publisher.other"],
      ["extra-position"],
    ];
    for (const rejected of rejectedArguments) {
      let checkCalls = 0;
      const errors: string[] = [];
      assert.equal(
        await runCli(
          ["pilot", "check", "--pilot", pilotId, ...rejected],
          { out: () => undefined, error: (message) => errors.push(message) },
          {
            checkPilot: async (options) => {
              checkCalls += 1;
              return await checkPilot({ ...options, doctorRunner: async () => readyDoctorOutput() });
            },
          },
        ),
        2,
      );
      assert.equal(checkCalls, 0);
      assert.ok(errors.some((message) => message.includes("pilot check does not accept")));
    }

    const timestamps = [
      "2026-08-26T10:20:00.000Z",
      "2026-08-26T10:26:00.000Z",
      "2026-08-26T10:32:00.000Z",
    ];
    const scenarioIds = ["authorize", "siws", "sign-message", "reject"];
    const run = await runPilot({
      pilotId,
      configPath,
      repeat: 3,
      projectRunner: passingRunner(directory, undefined, "Android/MWA Ready", scenarioIds),
      now: () => new Date(timestamps.shift() ?? "invalid"),
    });
    assert.equal(run.exitCode, 0);
    assert.equal(run.technicalPilot.qualified, true);
    assert.equal(run.technicalPilot.trailingMwaPasses, 3);
    assert.equal(run.technicalPilot.setupDurationMs, 20 * 60 * 1000);
    assert.equal(run.technicalPilot.medianRunDurationMs, 5 * 60 * 1000);
    assert.equal(run.externalGrantGate.grantReady, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pilot preflight reports policy gaps without calling device tools", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-policy-"));
  try {
    const configPath = await writePublisherProject(directory);
    const pilotId = "publisher-policy";
    const started = await startPilot({ pilotId, configPath });
    const stateBefore = await readFile(started.statePath, "utf8");
    let doctorCalled = false;
    const checked = await checkPilot({
      pilotId,
      configPath,
      doctorRunner: async () => {
        doctorCalled = true;
        return readyDoctorOutput();
      },
    });
    assert.equal(checked.exitCode, 2);
    assert.equal(checked.readyToRecord, false);
    assert.equal(doctorCalled, false);
    assert.equal(checked.doctor, undefined);
    assert.ok(
      checked.checks.some(
        (check) => check.id === "pilot.mwa-coverage" && check.status === "fail",
      ),
    );
    assert.ok(
      checked.checks.some(
        (check) => check.id === "pilot.environment" && check.status === "skip",
      ),
    );
    assert.equal(await readFile(started.statePath, "utf8"), stateBefore);

    await writeFullPublisherProject(directory);
    const fullSource = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      fullSource
        .replace("./siws.yaml", "./authorize.yaml")
        .replace("./sign-message.yaml", "./authorize.yaml")
        .replace("./reject.yaml", "./authorize.yaml"),
      "utf8",
    );
    const duplicateCoverage = await checkPilot({
      pilotId,
      configPath,
      doctorRunner: async () => {
        doctorCalled = true;
        return readyDoctorOutput();
      },
    });
    assert.equal(duplicateCoverage.exitCode, 2);
    assert.equal(doctorCalled, false);
    assert.ok(
      duplicateCoverage.checks.some(
        (check) =>
          check.id === "pilot.mwa-coverage" &&
          check.status === "fail" &&
          check.summary.includes("four distinct promoted flow files"),
      ),
    );
    await assert.rejects(
      () => runPilot({ pilotId, configPath, projectRunner: passingRunner(directory) }),
      (error: unknown) => error instanceof PilotError && error.message.includes("four distinct promoted flow files"),
    );
    assert.equal((await getPilotStatus({ pilotId, configPath })).metrics.runAttempts, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pilot run refuses init templates and reserved selectors before recording an attempt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-template-"));
  try {
    const configPath = await writePublisherProject(directory);
    const templatePath = path.join(directory, "mwa-authorize.example.yaml");
    await writeFile(
      templatePath,
      "appId: com.publisher.mobile\n---\n- assertVisible:\n    id: publisher-ready\n",
      "utf8",
    );
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace("./authorize.yaml", "./mwa-authorize.example.yaml"),
      "utf8",
    );
    const pilotId = "publisher-template";
    await startPilot({ pilotId, configPath });
    let runnerCalls = 0;
    await assert.rejects(
      () =>
        runPilot({
          pilotId,
          configPath,
          projectRunner: async (...args) => {
            runnerCalls += 1;
            return await passingRunner(directory)(...args);
          },
        }),
      (error: unknown) => error instanceof PilotError && error.message.includes("reserved init template"),
    );
    assert.equal(runnerCalls, 0);
    assert.equal((await getPilotStatus({ pilotId, configPath })).metrics.runAttempts, 0);

    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace("./mwa-authorize.example.yaml", "./authorize.yaml"),
      "utf8",
    );
    await writeFile(
      path.join(directory, "authorize.yaml"),
      [
        "appId: com.publisher.mobile",
        "---",
        "- runFlow:",
        "    when:",
        "      visible: \"TODO: publisher-condition\"",
        "    commands:",
        "      - tapOn: publisher-ready",
        "",
      ].join("\n"),
      "utf8",
    );
    await assert.rejects(
      () => runPilot({ pilotId, configPath, projectRunner: passingRunner(directory) }),
      (error: unknown) => error instanceof PilotError && error.message.includes("reserved TODO: selector"),
    );
    assert.equal((await getPilotStatus({ pilotId, configPath })).metrics.runAttempts, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pilot workflow records repeatability metrics and exports privacy-limited evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-"));
  try {
    const configPath = await writePublisherProject(directory);
    const pilotId = "publisher-alpha";
    await startPilot({
      pilotId,
      configPath,
      now: () => new Date("2026-08-26T10:00:00.000Z"),
    });
    const timestamps = [
      "2026-08-26T10:20:00.000Z",
      "2026-08-26T10:26:00.000Z",
      "2026-08-26T10:32:00.000Z",
    ];
    const output = await runPilot({
      pilotId,
      configPath,
      repeat: 3,
      projectRunner: passingRunner(directory),
      now: () => new Date(timestamps.shift() ?? "invalid"),
    });
    assert.equal(output.exitCode, 0);
    assert.match(output.metrics.executionFingerprintSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(output.metrics, {
      runAttempts: 3,
      qualifyingRuns: 3,
      passRate: 1,
      consecutivePasses: 3,
      medianRunDurationMs: 5 * 60 * 1000,
      setupDurationMs: 20 * 60 * 1000,
      executionFingerprintSha256: output.metrics.executionFingerprintSha256,
      setupTargetMet: true,
      runtimeTargetMet: true,
      repeatabilityTargetMet: true,
    });
    assert.equal(output.technicalPilot.qualified, false);
    assert.equal(output.technicalPilot.trailingMwaPasses, 0);
    assert.equal(output.technicalPilot.latestReadiness, "Android Device Ready");

    const status = await getPilotStatus({ pilotId, configPath });
    assert.deepEqual(status.metrics, output.metrics);
    assert.deepEqual(status.technicalPilot, output.technicalPilot);
    assert.equal(status.externalGrantGate.grantReady, false);
    const cliOutput: string[] = [];
    const cliErrors: string[] = [];
    assert.equal(
      await runCli(
        ["pilot", "status", "--pilot", pilotId, "--config", configPath, "--json"],
        { out: (message) => cliOutput.push(message), error: (message) => cliErrors.push(message) },
      ),
      0,
    );
    assert.equal(cliErrors.length, 0);
    assert.equal(JSON.parse(cliOutput.join("\n")).metrics.consecutivePasses, 3);
    const exported = await exportPilotEvidence({
      pilotId,
      configPath,
      outputPath: "./exports/publisher-alpha.json",
    });
    assert.equal(exported.evidence.claimStatus, "self-recorded-unattested");
    assert.deepEqual(new Set(Object.values(exported.evidence.claims)), new Set(["not-established"]));
    assert.equal(exported.evidence.runs.length, 3);
    assert.ok(exported.evidence.runs.every((run) => run.qualifying));
    assert.notEqual(exported.evidence.metrics.executionFingerprintSha256, output.metrics.executionFingerprintSha256);
    assert.equal("configSha256" in (exported.evidence.runs[0] ?? {}), false);
    assert.equal("flowSha256" in (exported.evidence.runs[0] ?? {}), false);
    assert.equal("reportSha256" in (exported.evidence.runs[0] ?? {}), false);
    const { evidenceSha256, ...core } = exported.evidence;
    assert.equal(evidenceSha256, sha256Value(core));
    const verifiedExport = await verifyPublicPilotEvidence(exported.outputPath);
    assert.equal(verifiedExport.integrityValid, true);
    assert.equal(verifiedExport.internalConsistencyValid, true);
    assert.equal(verifiedExport.reportedTechnicalTargetsMet, false);
    assert.equal(verifiedExport.grantReady, false);

    await assert.rejects(
      () => exportPilotEvidence({ pilotId, configPath, outputPath: status.statePath, force: true }),
      (error: unknown) => error instanceof PilotError && error.message.includes("cannot replace private state"),
    );
    const secondPilot = await startPilot({ pilotId: "publisher-beta", configPath });
    await assert.rejects(
      () => exportPilotEvidence({ pilotId, configPath, outputPath: secondPilot.statePath, force: true }),
      (error: unknown) => error instanceof PilotError && error.message.includes("cannot replace private state"),
    );
    const redirectedDirectory = path.join(directory, "redirected-pilot");
    await symlink(path.dirname(status.statePath), redirectedDirectory, "dir");
    await assert.rejects(
      () =>
        exportPilotEvidence({
          pilotId,
          configPath,
          outputPath: path.join(redirectedDirectory, "evidence.json"),
          force: true,
        }),
      (error: unknown) => error instanceof PilotError && error.message.includes("cannot replace private state"),
    );
    const privateLockPath = status.statePath + ".lock";
    await assert.rejects(
      () =>
        exportPilotEvidence({
          pilotId,
          configPath,
          outputPath: path.join(privateLockPath, "public.json"),
          force: true,
        }),
      (error: unknown) => error instanceof PilotError,
    );
    await assert.rejects(() => lstat(privateLockPath));

    const publicSource = await readFile(exported.outputPath, "utf8");
    assert.doesNotMatch(publicSource, /publisher-alpha/);
    assert.doesNotMatch(publicSource, /publisher-run/);
    assert.doesNotMatch(publicSource, /authorize/);
    assert.doesNotMatch(publicSource, /com\.publisher/);
    assert.doesNotMatch(publicSource, /recordedAt/);
    assert.doesNotMatch(publicSource, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const stateSource = JSON.parse(await readFile(status.statePath, "utf8")) as Record<string, any>;
    stateSource.runs[0].durationMs += 1;
    await writeFile(status.statePath, JSON.stringify(stateSource, null, 2) + "\n", "utf8");
    await assert.rejects(
      () => getPilotStatus({ pilotId, configPath }),
      (error: unknown) => error instanceof PilotError && error.message.includes("integrity check failed"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pilot repeatability resets when the execution fingerprint changes", () => {
  const baseRun: PilotRunEvidenceV1 = {
    runId: "publisher-run-1",
    recordedAt: "2026-08-26T10:05:00.000Z",
    outcome: "passed",
    readiness: "Android/MWA Ready",
    durationMs: 300_000,
    reportSha256: "1".repeat(64),
    configSha256: "2".repeat(64),
    flowSha256: { authorize: "3".repeat(64) },
    launchRigVersion: "0.1.0",
    appSnapshotSha256: "4".repeat(64),
    walletSnapshotSha256: "5".repeat(64),
    physicalDevice: true,
    requiredChecksPassed: true,
    qualifying: true,
  };
  const state: PilotStateCoreV1 = {
    schemaVersion: 1,
    pilotId: "publisher-fingerprint",
    evidenceId: "123e4567-e89b-42d3-a456-426614174000",
    startedAt: "2026-08-26T10:00:00.000Z",
    firstPassingRunAt: "2026-08-26T10:05:00.000Z",
    runs: [
      baseRun,
      { ...baseRun, runId: "publisher-run-2", recordedAt: "2026-08-26T10:10:00.000Z" },
      {
        ...baseRun,
        runId: "publisher-run-3",
        recordedAt: "2026-08-26T10:15:00.000Z",
        durationMs: 420_000,
        configSha256: "6".repeat(64),
      },
    ],
  };

  const metrics = pilotMetrics(state);
  assert.equal(metrics.qualifyingRuns, 3);
  assert.equal(metrics.consecutivePasses, 1);
  assert.equal(metrics.medianRunDurationMs, 420_000);
  assert.equal(metrics.repeatabilityTargetMet, false);

  const technical = pilotTechnicalGate(state);
  assert.equal(technical.qualified, false);
  assert.equal(technical.trailingMwaPasses, 1);
  assert.equal(technical.setupDurationMs, 5 * 60 * 1000);
  assert.equal(technical.medianRunDurationMs, 420_000);

  const completedState: PilotStateCoreV1 = {
    ...state,
    runs: [
      ...state.runs,
      {
        ...baseRun,
        runId: "publisher-run-4",
        recordedAt: "2026-08-26T10:20:00.000Z",
        durationMs: 360_000,
        configSha256: "6".repeat(64),
      },
      {
        ...baseRun,
        runId: "publisher-run-5",
        recordedAt: "2026-08-26T10:25:00.000Z",
        durationMs: 300_000,
        configSha256: "6".repeat(64),
      },
    ],
  };
  const completedTechnical = pilotTechnicalGate(completedState);
  assert.equal(completedTechnical.qualified, true);
  assert.equal(completedTechnical.trailingMwaPasses, 3);
  assert.equal(completedTechnical.medianRunDurationMs, 360_000);
});

test("pilot evidence v2 exposes a recomputable technical gate with per-export keyed fingerprints", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-v2-export-"));
  try {
    const configPath = await writeFullPublisherProject(directory);
    const scenarioIds = ["authorize", "siws", "sign-message", "reject"];
    const runOnePilot = async (pilotId: string, outputPath: string) => {
      await startPilot({
        pilotId,
        configPath,
        now: () => new Date("2026-08-26T10:00:00.000Z"),
      });
      const timestamps = [
        "2026-08-26T10:20:00.000Z",
        "2026-08-26T10:26:00.000Z",
        "2026-08-26T10:32:00.000Z",
      ];
      const runOutput = await runPilot({
        pilotId,
        configPath,
        repeat: 3,
        projectRunner: passingRunner(directory, undefined, "Android/MWA Ready", scenarioIds),
        now: () => new Date(timestamps.shift() ?? "invalid"),
      });
      assert.equal(runOutput.technicalPilot.qualified, true);
      return {
        runOutput,
        exported: await exportPilotEvidence({ pilotId, configPath, outputPath }),
      };
    };

    const first = await runOnePilot("publisher-v2-first", "./exports/first-v2.json");
    assert.equal(first.exported.evidence.schemaVersion, 2);
    assert.equal(first.exported.evidence.technicalPilot.qualified, true);
    assert.deepEqual(
      first.exported.evidence.runs.map((run) => run.elapsedSinceStartMs),
      [20 * 60_000, 26 * 60_000, 32 * 60_000],
    );
    const firstFingerprints = new Set(
      first.exported.evidence.runs.map((run) => run.executionFingerprintSha256),
    );
    assert.equal(firstFingerprints.size, 1);
    assert.equal(
      first.exported.evidence.metrics.executionFingerprintSha256,
      first.exported.evidence.runs.at(-1)?.executionFingerprintSha256,
    );
    assert.notEqual(
      first.exported.evidence.metrics.executionFingerprintSha256,
      first.runOutput.metrics.executionFingerprintSha256,
    );
    const verified = await verifyPublicPilotEvidence(first.exported.outputPath);
    assert.equal(verified.reportedTechnicalTargetsMet, true);
    assert.equal(verified.grantReady, false);

    const reexported = await exportPilotEvidence({
      pilotId: "publisher-v2-first",
      configPath,
      outputPath: "./exports/first-v2-reexport.json",
    });
    assert.equal(reexported.evidence.evidenceId, first.exported.evidence.evidenceId);
    assert.notEqual(
      reexported.evidence.runs[0]?.executionFingerprintSha256,
      first.exported.evidence.runs[0]?.executionFingerprintSha256,
    );
    assert.equal((await verifyPublicPilotEvidence(reexported.outputPath)).reportedTechnicalTargetsMet, true);

    const second = await runOnePilot("publisher-v2-second", "./exports/second-v2.json");
    assert.notEqual(first.exported.evidence.evidenceId, second.exported.evidence.evidenceId);
    assert.notEqual(
      first.exported.evidence.runs[0]?.executionFingerprintSha256,
      second.exported.evidence.runs[0]?.executionFingerprintSha256,
    );
    assert.notEqual(
      first.exported.evidence.metrics.executionFingerprintSha256,
      second.exported.evidence.metrics.executionFingerprintSha256,
    );

    const impossibleState = JSON.parse(await readFile(first.runOutput.statePath, "utf8")) as Record<string, any>;
    impossibleState.runs[1].recordedAt = "2026-08-26T10:21:00.000Z";
    const { integritySha256: _integrity, ...impossibleCore } = impossibleState;
    impossibleState.integritySha256 = sha256Value(impossibleCore);
    await writeFile(first.runOutput.statePath, JSON.stringify(impossibleState, null, 2) + "\n", "utf8");
    await assert.rejects(
      () =>
        exportPilotEvidence({
          pilotId: "publisher-v2-first",
          configPath,
          outputPath: "./exports/impossible-v2.json",
        }),
      (error: unknown) => error instanceof PilotError && error.message.includes("sequential run durations"),
    );

    const publicSource = await readFile(first.exported.outputPath, "utf8");
    assert.doesNotMatch(publicSource, /recordedAt|startedAt|publisher-v2-first|com\.publisher|authorize/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("optional MWA failure downgrades readiness without invalidating a passed pilot report", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-optional-mwa-"));
  try {
    const configPath = await writeFullPublisherProject(directory);
    await writeFile(
      path.join(directory, "stale-authorization.yaml"),
      "appId: com.publisher.mobile\n---\n- assertVisible:\n    id: publisher-stale-recovery\n",
      "utf8",
    );
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(
        "artifacts:",
        [
          "  - id: stale-authorization",
          "    kind: mwa-stale-authorization",
          "    name: Optional stale authorization",
          "    flow: ./stale-authorization.yaml",
          "    required: false",
          "artifacts:",
        ].join("\n"),
      ),
      "utf8",
    );
    const pilotId = "publisher-optional-mwa";
    await startPilot({ pilotId, configPath });
    const coreScenarioIds = ["authorize", "siws", "sign-message", "reject"];
    const optionalFailureRunner: PilotProjectRunner = async (...args) => {
      const output = await passingRunner(
        directory,
        undefined,
        "Android/MWA Ready",
        coreScenarioIds,
      )(...args);
      output.report.readiness = "Android Device Ready";
      output.report.checks.push({
        id: "scenario.stale-authorization",
        name: "Optional stale authorization",
        status: "fail",
        required: false,
        durationMs: 100,
        summary: "optional coverage failed",
      });
      await writeFile(output.artifacts.json, JSON.stringify(output.report, null, 2) + "\n", "utf8");
      return output;
    };
    const output = await runPilot({ pilotId, configPath, projectRunner: optionalFailureRunner });
    assert.equal(output.exitCode, 0);
    assert.equal(output.runs[0]?.qualifying, true);
    assert.equal(output.runs[0]?.readiness, "Android Device Ready");
    assert.equal(output.technicalPilot.qualified, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pilot records runner and report failures without inflating success metrics", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-failures-"));
  try {
    const configPath = await writePublisherProject(directory);
    await startPilot({
      pilotId: "publisher-delta",
      configPath,
      now: () => new Date("2026-08-26T10:00:00.000Z"),
    });
    const passing = passingRunner(directory);
    let call = 0;
    const runnerFailure: PilotProjectRunner = async (...args) => {
      call += 1;
      if (call === 2) throw new Error("publisher runner stopped");
      return await passing(...args);
    };
    const output = await runPilot({
      pilotId: "publisher-delta",
      configPath,
      repeat: 2,
      projectRunner: runnerFailure,
      now: (() => {
        const timestamps = ["2026-08-26T10:06:00.000Z", "2026-08-26T10:07:00.000Z"];
        return () => new Date(timestamps.shift() ?? "invalid");
      })(),
    });
    assert.equal(output.exitCode, 3);
    assert.equal(output.metrics.runAttempts, 2);
    assert.equal(output.metrics.qualifyingRuns, 1);
    assert.equal(output.metrics.passRate, 0.5);
    assert.equal(output.metrics.executionFingerprintSha256, null);
    assert.equal(output.runs[1]?.failureKind, "runner-error");
    const exported = await exportPilotEvidence({ pilotId: "publisher-delta", configPath });
    assert.equal(exported.evidence.metrics.passRate, 0.5);
    assert.equal(exported.evidence.runs[1]?.failureKind, "runner-error");

    await startPilot({ pilotId: "publisher-epsilon", configPath });
    const invalidReport: PilotProjectRunner = async (...args) => {
      const result = await passingRunner(directory)(...args);
      await writeFile(result.artifacts.json, "not JSON\n", "utf8");
      return result;
    };
    const invalid = await runPilot({
      pilotId: "publisher-epsilon",
      configPath,
      projectRunner: invalidReport,
    });
    assert.equal(invalid.exitCode, 3);
    assert.equal(invalid.runs[0]?.failureKind, "report-invalid");

    await startPilot({ pilotId: "publisher-iota", configPath });
    const mismatchedReport: PilotProjectRunner = async (...args) => {
      const result = await passingRunner(directory)(...args);
      const artifact = JSON.parse(await readFile(result.artifacts.json, "utf8")) as Record<string, unknown>;
      artifact.launchRigVersion = "9.9.9";
      await writeFile(result.artifacts.json, JSON.stringify(artifact, null, 2) + "\n", "utf8");
      return result;
    };
    const mismatched = await runPilot({
      pilotId: "publisher-iota",
      configPath,
      projectRunner: mismatchedReport,
    });
    assert.equal(mismatched.exitCode, 3);
    assert.equal(mismatched.runs[0]?.failureKind, "report-invalid");

    await startPilot({ pilotId: "publisher-mwa-label", configPath });
    const falseMwaReadiness = await runPilot({
      pilotId: "publisher-mwa-label",
      configPath,
      projectRunner: passingRunner(directory, undefined, "Android/MWA Ready"),
    });
    assert.equal(falseMwaReadiness.exitCode, 3);
    assert.equal(falseMwaReadiness.runs[0]?.failureKind, "report-invalid");

    await startPilot({ pilotId: "publisher-lambda", configPath });
    const wrongWalletBinary: PilotProjectRunner = async (...args) => {
      const result = await passingRunner(directory)(...args);
      if (result.report.wallet) result.report.wallet.apkSha256 = "c".repeat(64);
      await writeFile(result.artifacts.json, JSON.stringify(result.report, null, 2) + "\n", "utf8");
      return result;
    };
    const wrongBinary = await runPilot({
      pilotId: "publisher-lambda",
      configPath,
      projectRunner: wrongWalletBinary,
    });
    assert.equal(wrongBinary.exitCode, 3);
    assert.equal(wrongBinary.runs[0]?.failureKind, "report-invalid");

    const configuredAppDirectory = path.join(directory, "configured-app");
    await mkdir(configuredAppDirectory);
    const configuredAppPath = await writePublisherProject(configuredAppDirectory);
    await writeFile(path.join(configuredAppDirectory, "publisher.apk"), "publisher artifact", "utf8");
    const configuredSource = await readFile(configuredAppPath, "utf8");
    await writeFile(
      configuredAppPath,
      configuredSource.replace("  install: false", "  apk: ./publisher.apk\n  install: false"),
      "utf8",
    );
    await startPilot({ pilotId: "publisher-artifact", configPath: configuredAppPath });
    const artifactMismatch = await runPilot({
      pilotId: "publisher-artifact",
      configPath: configuredAppPath,
      projectRunner: passingRunner(configuredAppDirectory),
    });
    assert.equal(artifactMismatch.exitCode, 3);
    assert.equal(artifactMismatch.runs[0]?.failureKind, "report-invalid");

    await startPilot({ pilotId: "publisher-kappa", configPath });
    const symlinkedReport: PilotProjectRunner = async (...args) => {
      const result = await passingRunner(directory)(...args);
      const outsideReport = path.join(directory, "outside-report.json");
      await writeFile(outsideReport, await readFile(result.artifacts.json));
      await rm(result.artifacts.json);
      await symlink(outsideReport, result.artifacts.json);
      return result;
    };
    const symlinked = await runPilot({
      pilotId: "publisher-kappa",
      configPath,
      projectRunner: symlinkedReport,
    });
    assert.equal(symlinked.exitCode, 3);
    assert.equal(symlinked.runs[0]?.failureKind, "report-invalid");

    await assert.rejects(
      () =>
        runPilot({
          pilotId: "publisher-epsilon",
          configPath,
          runOptions: { scenarioId: "authorize" },
          projectRunner: passingRunner(directory),
        }),
      (error: unknown) => error instanceof PilotError && error.message.includes("every configured scenario"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pilot force-start replaces a state symlink without touching its target", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-outside-"));
  try {
    const configPath = await writePublisherProject(directory);
    const stateDirectory = path.join(directory, ".launchrig", "pilots", "publisher-zeta");
    await mkdir(stateDirectory, { recursive: true });
    const outsideFile = path.join(outside, "sentinel.txt");
    await writeFile(outsideFile, "sentinel", "utf8");
    const statePath = path.join(stateDirectory, "evidence.json");
    await symlink(outsideFile, statePath);
    await startPilot({ pilotId: "publisher-zeta", configPath, force: true });
    assert.equal(await readFile(outsideFile, "utf8"), "sentinel");
    assert.equal((await lstat(statePath)).isSymbolicLink(), false);

    const escapedProject = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-escaped-"));
    try {
      const escapedConfig = await writePublisherProject(escapedProject);
      await symlink(outside, path.join(escapedProject, ".launchrig"));
      await assert.rejects(
        () => startPilot({ pilotId: "publisher-eta", configPath: escapedConfig }),
        (error: unknown) => error instanceof PilotError && error.message.includes("project-owned directories"),
      );
    } finally {
      await rm(escapedProject, { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("pilot refuses controlled fixtures and input mutation", async () => {
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-fixture-"));
  const publisherDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-mutation-"));
  try {
    const fixtureConfig = await writePublisherProject(fixtureDirectory, "dev.launchrig.fixture");
    await startPilot({ pilotId: "fixture", configPath: fixtureConfig });
    await assert.rejects(
      () => runPilot({ pilotId: "fixture", configPath: fixtureConfig, projectRunner: passingRunner(fixtureDirectory) }),
      (error: unknown) => error instanceof PilotError && error.message.includes("cannot be recorded"),
    );

    const publisherConfig = await writePublisherProject(publisherDirectory);
    await startPilot({ pilotId: "publisher-beta", configPath: publisherConfig });
    const runner = passingRunner(publisherDirectory);
    const mutatingRunner: PilotProjectRunner = async (...args) => {
      assert.notEqual(args[0], publisherConfig);
      assert.equal(args[1]?.requireInstalledArtifactHashes, true);
      const stagedConfig = await loadConfig(args[0]);
      const stagedFlow = stagedConfig.scenarios[0]?.resolvedFlow;
      assert.ok(stagedFlow);
      assert.notEqual(stagedFlow, path.join(publisherDirectory, "authorize.yaml"));
      const output = await runner(...args);
      await writeFile(
        path.join(publisherDirectory, "authorize.yaml"),
        "appId: com.publisher.mobile\n---\n- assertVisible: Changed\n",
        "utf8",
      );
      assert.match(await readFile(stagedFlow, "utf8"), /assertVisible: Connect/);
      return output;
    };
    const mutation = await runPilot({
      pilotId: "publisher-beta",
      configPath: publisherConfig,
      projectRunner: mutatingRunner,
    });
    assert.equal(mutation.exitCode, 3);
    assert.equal(mutation.runs[0]?.failureKind, "input-mutation");
    assert.equal((await getPilotStatus({ pilotId: "publisher-beta", configPath: publisherConfig })).metrics.runAttempts, 1);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
    await rm(publisherDirectory, { recursive: true, force: true });
  }
});

test("pilot setup timer can start before configuration work begins", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-setup-timer-"));
  try {
    const output = await startPilot({
      pilotId: "publisher-theta",
      configPath: path.join(directory, "launchrig.yml"),
      now: () => new Date("2026-08-26T09:00:00.000Z"),
    });
    const state = await readPilotState(output.statePath);
    assert.equal(state.startedAt, "2026-08-26T09:00:00.000Z");
    assert.equal(state.runs.length, 0);
    assert.equal((await lstat(output.statePath)).mode & 0o777, 0o600);
    assert.equal((await lstat(path.dirname(output.statePath))).mode & 0o777, 0o700);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pilot state parser rejects duplicate JSON keys and duplicate run IDs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-pilot-strict-"));
  try {
    const configPath = await writePublisherProject(directory);
    const started = await startPilot({ pilotId: "publisher-gamma", configPath });
    const source = await readFile(started.statePath, "utf8");
    await writeFile(started.statePath, source.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,'), "utf8");
    await assert.rejects(
      () => readPilotState(started.statePath),
      (error: unknown) => error instanceof PilotError && error.message.includes("strict JSON"),
    );

    await startPilot({ pilotId: "publisher-gamma", configPath, force: true });
    await assert.rejects(
      () =>
        runPilot({
          pilotId: "publisher-gamma",
          configPath,
          repeat: 2,
          projectRunner: passingRunner(directory, "duplicate-run"),
        }),
      (error: unknown) => error instanceof PilotError && error.message.includes("duplicate run ID"),
    );
    assert.equal((await getPilotStatus({ pilotId: "publisher-gamma", configPath })).metrics.runAttempts, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
