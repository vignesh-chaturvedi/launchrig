import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CheckResult,
  DeviceSnapshot,
  LaunchRigReport,
  PackageSnapshot,
  ResolvedLaunchRigConfig,
  ScenarioConfig,
} from "../types.js";
import { AdbClient, selectDevice } from "../device/adb.js";
import { maskKnownIdentifiers } from "../device/privacy.js";
import { createReport, createRunId } from "../report/model.js";
import { pruneReportDirectories } from "../report/retention.js";
import { writeReportArtifacts, type WrittenArtifacts } from "../report/write.js";
import { redactText } from "../security/redact.js";
import { validateMaestroFlowSafety } from "../security/flow.js";
import {
  managedWalletExpectedSha256,
  sha256File,
  stageManagedWalletArtifact,
} from "../security/wallet-artifact.js";
import { adbCandidates, findExecutable, maestroCandidates } from "../utils/executable.js";
import { MaestroClient, minimalMaestroEnvironment } from "./maestro.js";

export interface RunOptions {
  deviceSerial?: string;
  adbPath?: string;
  maestroPath?: string;
  scenarioId?: string;
  requireInstalledArtifactHashes?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface RunOutput {
  report: LaunchRigReport;
  artifacts: WrittenArtifacts;
  exitCode: 0 | 1 | 3;
}

function result(input: Omit<CheckResult, "durationMs"> & { startedAt: number }): CheckResult {
  const { startedAt, ...rest } = input;
  return { ...rest, durationMs: Date.now() - startedAt };
}

function safeText(value: string, patterns: string[], identifiers: string[] = []): string {
  return redactText(maskKnownIdentifiers(value, identifiers), patterns).value;
}

function safeDetails(
  stdout: Buffer,
  stderr: Buffer,
  patterns: string[],
  identifiers: string[] = [],
): string | undefined {
  const combined = [stdout.toString("utf8").trim(), stderr.toString("utf8").trim()].filter(Boolean).join("\n");
  if (!combined) return undefined;
  return safeText(combined, patterns, identifiers).slice(0, 12000);
}

async function finalize(input: {
  config: ResolvedLaunchRigConfig;
  startedAt: Date;
  runId: string;
  runDirectory: string;
  checks: CheckResult[];
  device?: DeviceSnapshot;
  app?: PackageSnapshot;
  wallet?: PackageSnapshot;
  setupError?: boolean;
  mwaCoverageComplete?: boolean;
}): Promise<RunOutput> {
  const completedAt = new Date();
  const report = createReport({
    runId: input.runId,
    project: input.config.project.name,
    packageName: input.config.project.packageName,
    network: input.config.target.network,
    startedAt: input.startedAt,
    completedAt,
    checks: input.checks,
    ...(input.app ? { app: input.app } : {}),
    ...(input.wallet ? { wallet: input.wallet } : {}),
    ...(input.device ? { device: input.device } : {}),
    ...(input.setupError ? { setupError: true } : {}),
    ...(input.mwaCoverageComplete ? { mwaCoverageComplete: true } : {}),
  });
  const artifacts = await writeReportArtifacts(report, input.runDirectory, input.config.privacy.redactPatterns);
  await pruneReportDirectories(input.config.resolvedArtifactDirectory, input.config.artifacts.retention);
  return {
    report,
    artifacts,
    exitCode: report.outcome === "passed" ? 0 : report.outcome === "failed" ? 1 : 3,
  };
}

async function captureFailureEvidence(input: {
  adb: AdbClient;
  serial: string;
  scenario: ScenarioConfig;
  scenarioDirectory: string;
  config: ResolvedLaunchRigConfig;
  failed: boolean;
}): Promise<string[]> {
  const artifacts: string[] = [];
  const shouldCaptureScreenshot =
    input.config.artifacts.screenshots === "always" ||
    (input.config.artifacts.screenshots === "failure" && input.failed);
  if (shouldCaptureScreenshot) {
    const screenshot = await input.adb.screenshot(input.serial);
    if (screenshot.exitCode === 0 && screenshot.stdout.length > 0) {
      const screenshotPath = path.join(input.scenarioDirectory, "failure.png");
      await writeFile(screenshotPath, screenshot.stdout, { mode: 0o600 });
      artifacts.push(path.relative(input.config.resolvedArtifactDirectory, screenshotPath));
    }
  }
  if (input.failed && input.config.privacy.includeLogcat) {
    const logcat = await input.adb.logcat(
      input.serial,
      input.config.privacy.logcatLines,
      input.config.project.packageName,
    );
    if (logcat.exitCode === 0) {
      const logPath = path.join(input.scenarioDirectory, "logcat.txt");
      const sanitized = safeText(logcat.stdout.toString("utf8"), input.config.privacy.redactPatterns, [input.serial]);
      await writeFile(logPath, sanitized.slice(0, 512 * 1024), { encoding: "utf8", mode: 0o600 });
      artifacts.push(path.relative(input.config.resolvedArtifactDirectory, logPath));
    }
  }
  return artifacts;
}

export async function runLaunchRig(config: ResolvedLaunchRigConfig, options: RunOptions = {}): Promise<RunOutput> {
  const startedAt = new Date();
  const runId = createRunId(startedAt);
  const runDirectory = path.join(config.resolvedArtifactDirectory, runId);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const checks: CheckResult[] = [];
  const env = options.env ?? process.env;
  let deviceSnapshot: DeviceSnapshot | undefined;
  let appSnapshot: PackageSnapshot | undefined;
  let walletSnapshot: PackageSnapshot | undefined;

  const adbStarted = Date.now();
  const adbPath = await findExecutable(
    "adb",
    options.adbPath ?? config.tooling.adb ?? env.LAUNCHRIG_ADB_PATH ?? env.LAUNCHRIG_ADB,
    adbCandidates(env),
    env,
  );
  if (!adbPath) {
    checks.push(
      result({
        id: "tool.adb",
        name: "ADB available",
        status: "fail",
        required: true,
        startedAt: adbStarted,
        summary: "ADB was not found. Install Android Platform Tools or set LAUNCHRIG_ADB_PATH.",
      }),
    );
    return await finalize({ config, startedAt, runId, runDirectory, checks, setupError: true });
  }

  const adb = new AdbClient(adbPath);
  try {
    const version = await adb.version();
    checks.push(
      result({
        id: "tool.adb",
        name: "ADB available",
        status: "pass",
        required: true,
        startedAt: adbStarted,
        summary: version.split(/\r?\n/)[0] ?? "ADB available",
      }),
    );
  } catch (error) {
    checks.push(
      result({
        id: "tool.adb",
        name: "ADB available",
        status: "fail",
        required: true,
        startedAt: adbStarted,
        summary: error instanceof Error ? error.message : String(error),
      }),
    );
    return await finalize({ config, startedAt, runId, runDirectory, checks, setupError: true });
  }

  const deviceStarted = Date.now();
  let serial: string;
  const deviceIdentifiers = [options.deviceSerial ?? env.ANDROID_SERIAL ?? ""];
  try {
    const devices = await adb.listDevices();
    deviceIdentifiers.push(...devices.map((device) => device.serial));
    const selected = selectDevice(
      devices,
      options.deviceSerial ?? env.ANDROID_SERIAL,
      config.device.requirePhysical,
    );
    serial = selected.serial;
    deviceSnapshot = await adb.snapshot(selected);
    checks.push(
      result({
        id: "device.connected",
        name: "Authorized physical Android device",
        status: deviceSnapshot.isEmulator && config.device.requirePhysical ? "fail" : "pass",
        required: true,
        startedAt: deviceStarted,
        summary: deviceSnapshot.manufacturer + " " + deviceSnapshot.model + " connected over USB/ADB",
      }),
    );
  } catch (error) {
    checks.push(
      result({
        id: "device.connected",
        name: "Authorized physical Android device",
        status: "fail",
        required: true,
        startedAt: deviceStarted,
        summary: safeText(
          error instanceof Error ? error.message : String(error),
          config.privacy.redactPatterns,
          deviceIdentifiers,
        ),
      }),
    );
    return await finalize({ config, startedAt, runId, runDirectory, checks, setupError: true });
  }

  const apiStarted = Date.now();
  const apiPass = deviceSnapshot.apiLevel >= config.device.minimumApiLevel;
  checks.push(
    result({
      id: "device.api",
      name: "Android API compatibility",
      status: apiPass ? "pass" : "fail",
      required: true,
      startedAt: apiStarted,
      summary: apiPass
        ? "API " + deviceSnapshot.apiLevel + " meets the minimum " + config.device.minimumApiLevel
        : "API " + deviceSnapshot.apiLevel + " is below the minimum " + config.device.minimumApiLevel,
    }),
  );

  const appPresentBeforeInstall = await adb.isPackageInstalled(serial, config.project.packageName);
  if (config.project.install && config.resolvedApk) {
    const installStarted = Date.now();
    if (appPresentBeforeInstall && config.project.installPolicy === "if-missing") {
      checks.push(
        result({
          id: "app.install",
          name: "Install app APK",
          status: "pass",
          required: true,
          startedAt: installStarted,
          summary: "App already installed; reinstall skipped by if-missing policy",
        }),
      );
    } else {
      const install = await adb.installApk(serial, config.resolvedApk);
      const installDetails = safeDetails(install.stdout, install.stderr, config.privacy.redactPatterns, [serial]);
      checks.push(
        result({
          id: "app.install",
          name: "Install app APK",
          status: install.exitCode === 0 ? "pass" : "fail",
          required: true,
          startedAt: installStarted,
          summary: install.exitCode === 0 ? "APK installed without clearing app data" : "ADB could not install the APK",
          ...(installDetails ? { details: installDetails } : {}),
        }),
      );
    }
  }

  const appStarted = Date.now();
  const appInstalled = await adb.isPackageInstalled(serial, config.project.packageName);
  if (appInstalled) appSnapshot = await adb.packageSnapshot(serial, config.project.packageName);
  checks.push(
    result({
      id: "app.installed",
      name: "App under test installed",
      status: appInstalled ? "pass" : "fail",
      required: true,
      startedAt: appStarted,
      summary: appInstalled
        ? config.project.packageName + " is installed"
        : config.project.packageName + " is not installed on the selected phone",
    }),
  );
  if (options.requireInstalledArtifactHashes) {
    const appBinaryStarted = Date.now();
    let expectedAppSha256: string | undefined;
    if (config.resolvedApk) {
      try {
        expectedAppSha256 = await sha256File(config.resolvedApk);
      } catch {
        expectedAppSha256 = undefined;
      }
    }
    const appBinaryMatches = Boolean(
      appSnapshot?.apkSha256 &&
        (config.resolvedApk ? expectedAppSha256 && appSnapshot.apkSha256 === expectedAppSha256 : true),
    );
    checks.push(
      result({
        id: "app.binary",
        name: "Installed app binary identity",
        status: appBinaryMatches ? "pass" : "fail",
        required: true,
        startedAt: appBinaryStarted,
        summary: appBinaryMatches
          ? expectedAppSha256
            ? "Installed app APK matches the configured artifact"
            : "Installed app APK hash captured"
          : config.resolvedApk
            ? "Installed app APK does not match the configured artifact"
            : "Installed app APK hash could not be captured",
      }),
    );
  }

  if (config.wallet.packageName) {
    const walletPresentBeforeInstall = await adb.isPackageInstalled(serial, config.wallet.packageName);
    if (config.wallet.install && config.resolvedWalletApk) {
      const walletInstallStarted = Date.now();
      if (walletPresentBeforeInstall && config.wallet.installPolicy === "if-missing") {
        checks.push(
          result({
            id: "wallet.install",
            name: "Install allowlisted test wallet APK",
            status: "pass",
            required: true,
            startedAt: walletInstallStarted,
            summary: "Test wallet already installed; reinstall skipped by if-missing policy",
          }),
        );
      } else {
        const stagedWallet = await stageManagedWalletArtifact(
          config.wallet.packageName,
          config.resolvedWalletApk,
        );
        if (!stagedWallet.valid || !stagedWallet.apkPath) {
          checks.push(
            result({
              id: "wallet.install",
              name: "Install allowlisted test wallet APK",
              status: "fail",
              required: true,
              startedAt: walletInstallStarted,
              summary: "Managed test-wallet APK does not match its pinned SHA-256 contract",
              ...(stagedWallet.actualSha256
                ? { details: "Observed SHA-256: " + stagedWallet.actualSha256 }
                : {}),
            }),
          );
          await stagedWallet.dispose();
        } else {
          try {
            const walletInstall = await adb.installApk(serial, stagedWallet.apkPath);
            const walletInstallDetails = safeDetails(
              walletInstall.stdout,
              walletInstall.stderr,
              config.privacy.redactPatterns,
              [serial],
            );
            checks.push(
              result({
                id: "wallet.install",
                name: "Install allowlisted test wallet APK",
                status: walletInstall.exitCode === 0 ? "pass" : "fail",
                required: true,
                startedAt: walletInstallStarted,
                summary:
                  walletInstall.exitCode === 0
                    ? "Pinned test wallet installed without clearing its data"
                    : "ADB could not install the test wallet APK",
                ...(walletInstallDetails ? { details: walletInstallDetails } : {}),
              }),
            );
          } finally {
            await stagedWallet.dispose();
          }
        }
      }
    }
    const walletStarted = Date.now();
    const walletInstalled = await adb.isPackageInstalled(serial, config.wallet.packageName);
    if (walletInstalled) walletSnapshot = await adb.packageSnapshot(serial, config.wallet.packageName);
    checks.push(
      result({
        id: "wallet.installed",
        name:
          config.wallet.mode === "mock-mwa"
            ? "Mock MWA Wallet installed"
            : config.wallet.mode === "reference-fakewallet"
              ? "Reference MWA fake wallet installed"
              : "Wallet installed",
        status: walletInstalled ? "pass" : "fail",
        required: config.scenarios.length > 0,
        startedAt: walletStarted,
        summary: walletInstalled
          ? config.wallet.packageName + " is installed"
          : config.wallet.packageName + " is not installed on the selected phone",
      }),
    );
    if (options.requireInstalledArtifactHashes) {
      const walletBinaryStarted = Date.now();
      const expectedWalletSha256 = managedWalletExpectedSha256(config.wallet.packageName);
      const walletBinaryMatches = Boolean(
        expectedWalletSha256 && walletSnapshot?.apkSha256 === expectedWalletSha256,
      );
      checks.push(
        result({
          id: "wallet.binary",
          name: "Installed test-wallet binary identity",
          status: walletBinaryMatches ? "pass" : "fail",
          required: true,
          startedAt: walletBinaryStarted,
          summary: walletBinaryMatches
            ? "Installed test-wallet APK matches the managed artifact contract"
            : "Installed test-wallet APK does not match the managed artifact contract",
        }),
      );
    }
  }

  let scenarios = config.scenarios;
  if (options.scenarioId) {
    scenarios = scenarios.filter((scenario) => scenario.id === options.scenarioId);
    if (scenarios.length === 0) {
      checks.push(
        result({
          id: "scenario.selection",
          name: "Scenario selection",
          status: "fail",
          required: true,
          startedAt: Date.now(),
          summary: "Scenario " + options.scenarioId + " does not exist in the configuration",
        }),
      );
    }
  }

  if (scenarios.length === 0 && !options.scenarioId) {
    checks.push(
      result({
        id: "scenario.none",
        name: "MWA scenarios configured",
        status: "warn",
        required: false,
        startedAt: Date.now(),
        summary: "Device checks ran, but no Maestro/MWA flows are configured yet.",
      }),
    );
  }

  if (scenarios.length > 0) {
    const maestroStarted = Date.now();
    const maestroPath = await findExecutable(
      "maestro",
      options.maestroPath ?? config.tooling.maestro ?? env.LAUNCHRIG_MAESTRO_PATH,
      maestroCandidates(),
      env,
    );
    if (!maestroPath) {
      checks.push(
        result({
          id: "tool.maestro",
          name: "Maestro available",
          status: "fail",
          required: true,
          startedAt: maestroStarted,
          summary: "Maestro was not found. Install it or set LAUNCHRIG_MAESTRO_PATH.",
        }),
      );
      return await finalize({
        config,
        startedAt,
        runId,
        runDirectory,
        checks,
        device: deviceSnapshot,
        ...(appSnapshot ? { app: appSnapshot } : {}),
        ...(walletSnapshot ? { wallet: walletSnapshot } : {}),
        setupError: true,
      });
    }
    const maestro = new MaestroClient(maestroPath);
    const maestroEnv = minimalMaestroEnvironment(env, path.dirname(adbPath));
    const maestroVersion = await maestro.version(maestroEnv);
    checks.push(
      result({
        id: "tool.maestro",
        name: "Maestro available",
        status: maestroVersion.exitCode === 0 ? "pass" : "fail",
        required: true,
        startedAt: maestroStarted,
        summary:
          maestroVersion.exitCode === 0
            ? maestroVersion.stdout.toString("utf8").trim() || "Maestro available"
            : "Maestro version check failed",
      }),
    );

    for (const scenario of scenarios) {
      const scenarioStarted = Date.now();
      const scenarioDirectory = path.join(runDirectory, "scenarios", scenario.id);
      if (config.wallet.mode === "reference-fakewallet" && config.wallet.packageName) {
        const reset = await adb.forceStopPackage(serial, config.wallet.packageName);
        if (reset.exitCode !== 0) {
          const resetDetails = safeDetails(reset.stdout, reset.stderr, config.privacy.redactPatterns, [serial]);
          checks.push(
            result({
              id: "scenario." + scenario.id,
              name: scenario.name,
              status: "fail",
              required: scenario.required,
              startedAt: scenarioStarted,
              summary: "Could not reset the allowlisted reference wallet before the flow",
              ...(resetDetails ? { details: resetDetails } : {}),
              reproduction: [
                "Connect the same Android phone with USB debugging enabled.",
                "Force-stop only " + config.wallet.packageName + ".",
                "Run launchrig run --scenario " + scenario.id + ".",
              ],
            }),
          );
          continue;
        }
      }
      let flowSource: string;
      try {
        flowSource = await readFile(scenario.resolvedFlow, "utf8");
      } catch {
        checks.push(
          result({
            id: "scenario." + scenario.id,
            name: scenario.name,
            status: "fail",
            required: scenario.required,
            startedAt: scenarioStarted,
            summary: "Scenario flow could not be read safely",
          }),
        );
        continue;
      }
      const flowSafetyIssues = validateMaestroFlowSafety(flowSource, config.project.packageName);
      if (flowSafetyIssues.length > 0) {
        checks.push(
          result({
            id: "scenario." + scenario.id,
            name: scenario.name,
            status: "fail",
            required: scenario.required,
            startedAt: scenarioStarted,
            summary: "Scenario flow failed the LaunchRig policy contract",
            details: flowSafetyIssues.join("\n"),
          }),
        );
        continue;
      }
      const stagedFlowDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrig-flow-"));
      const stagedFlowPath = path.join(stagedFlowDirectory, "flow.yaml");
      let execution;
      try {
        await writeFile(stagedFlowPath, flowSource, { encoding: "utf8", flag: "wx", mode: 0o400 });
        execution = await maestro.runFlow({
          serial,
          flowPath: stagedFlowPath,
          outputDirectory: scenarioDirectory,
          timeoutMs: scenario.timeoutMs,
          redactPatterns: config.privacy.redactPatterns,
          env: maestroEnv,
        });
      } finally {
        await rm(stagedFlowDirectory, { recursive: true, force: true });
      }
      const failed = execution.exitCode !== 0;
      const evidence = await captureFailureEvidence({
        adb,
        serial,
        scenario,
        scenarioDirectory,
        config,
        failed,
      });
      const maestroJunitPath = path.join(scenarioDirectory, "maestro-junit.xml");
      try {
        await access(maestroJunitPath);
        evidence.unshift(path.relative(config.resolvedArtifactDirectory, maestroJunitPath));
      } catch {
        // The process output remains available in details when Maestro exits before writing JUnit.
      }
      const details = failed
        ? safeDetails(execution.stdout, execution.stderr, config.privacy.redactPatterns, [serial])
        : undefined;
      checks.push(
        result({
          id: "scenario." + scenario.id,
          name: scenario.name,
          status: failed ? "fail" : "pass",
          required: scenario.required,
          startedAt: scenarioStarted,
          summary: failed ? "Maestro flow failed" : "Maestro flow passed",
          ...(details ? { details } : {}),
          reproduction: [
            "Connect the same Android phone with USB debugging enabled.",
            config.wallet.mode === "mock-mwa"
              ? "Authenticate Mock MWA Wallet before starting its 15-minute signing window."
              : "Use only the configured reference test wallet for this fixture flow.",
            "Run launchrig run --scenario " + scenario.id + ".",
          ],
          ...(evidence.length > 0 ? { artifacts: evidence } : {}),
        }),
      );
    }
  }

  return await finalize({
    config,
    startedAt,
    runId,
    runDirectory,
    checks,
    device: deviceSnapshot,
    ...(appSnapshot ? { app: appSnapshot } : {}),
    ...(walletSnapshot ? { wallet: walletSnapshot } : {}),
    mwaCoverageComplete:
      Boolean(
        walletSnapshot &&
          checks.some((check) => check.id === "wallet.installed" && check.required && check.status === "pass"),
      ) &&
      scenarios
        .filter((scenario) => scenario.kind.startsWith("mwa-"))
        .every((scenario) => checks.some((check) => check.id === "scenario." + scenario.id && check.status === "pass")) &&
      ["mwa-authorize", "mwa-siws", "mwa-sign-message", "mwa-reject"].every((kind) =>
        scenarios.some(
          (scenario) =>
            scenario.kind === kind &&
            scenario.required &&
            checks.some(
              (check) => check.id === "scenario." + scenario.id && check.required && check.status === "pass",
            ),
        ),
      ),
  });
}
