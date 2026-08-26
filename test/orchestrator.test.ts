import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/load.js";
import { runLaunchRig } from "../src/runner/orchestrator.js";

const FAKE_ADB = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("Android Debug Bridge version 1.0.41");
} else if (args[0] === "devices") {
  console.log("List of devices attached\\nA1F0 device usb:1-1 product:fixture model:Fixture_Phone device:fixture transport_id:1");
} else if (args[0] === "-s" && args[2] === "shell" && args[3] === "getprop") {
  console.log("[ro.product.manufacturer]: [Fixture]\\n[ro.product.model]: [Phone]\\n[ro.build.version.release]: [16]\\n[ro.build.version.sdk]: [36]\\n[ro.product.cpu.abi]: [arm64-v8a]\\n[ro.build.version.security_patch]: [2026-08-01]\\n[ro.kernel.qemu]: [0]");
} else if (args[0] === "-s" && args[2] === "shell" && args[3] === "dumpsys" && args[4] === "battery") {
  console.log("level: 80");
} else if (args[0] === "-s" && args[2] === "shell" && args[3] === "dumpsys" && args[4] === "package") {
  console.log("  versionCode=220 minSdk=23 targetSdk=36\\n  versionName=2.2.0");
} else if (args[0] === "-s" && args[2] === "shell" && args[3] === "df") {
  console.log("Filesystem 1K-blocks Used Available Use% Mounted on\\n/dev/data 1000000 1000 999000 1% /data");
} else if (args[0] === "-s" && args[2] === "shell" && args[3] === "pm") {
  console.log("package:/data/app/base.apk");
} else if (args[0] === "-s" && args[2] === "exec-out") {
  process.stdout.write(Buffer.from([137,80,78,71,13,10,26,10]));
} else if (args[0] === "-s" && args[2] === "install") {
  if (process.env.LAUNCHRIG_TEST_ADB_INSTALL_FAIL === "1") {
    console.error("device '" + args[1] + "' not found");
    process.exitCode = 1;
  } else {
    console.log("Success");
  }
} else {
  console.error("Unexpected fake adb args: " + args.join(" "));
  process.exitCode = 1;
}
`;

const FAKE_MAESTRO = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("2.0.0-fixture");
} else {
  const device = args.find((arg) => arg.startsWith("--device="))?.slice("--device=".length) ?? "unknown";
  if (process.env.LAUNCHRIG_TEST_MAESTRO_FAIL === "1") {
    console.log("Flow failed on device " + device.toLowerCase());
    console.error("Transport disconnected for " + device);
    process.exitCode = 1;
    return;
  }
  const outputIndex = args.indexOf("--output");
  if (outputIndex >= 0) {
    const output = args[outputIndex + 1];
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, "<testsuite tests=\\"1\\" failures=\\"0\\"/>");
  }
  console.log("Flow passed");
}
`;

async function createExecutable(directory: string, name: string, content: string): Promise<string> {
  const target = path.join(directory, name);
  await writeFile(target, content, "utf8");
  await chmod(target, 0o755);
  return target;
}

test("physical-device run produces an Android/MWA Ready evidence set", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-run-"));
  try {
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    const adb = await createExecutable(bin, "adb", FAKE_ADB);
    const maestro = await createExecutable(bin, "maestro", FAKE_MAESTRO);
    await writeFile(path.join(directory, "app.apk"), "fixture", "utf8");
    await writeFile(path.join(directory, "wallet.apk"), "fixture", "utf8");
    await writeFile(path.join(directory, "authorize.yaml"), "appId: dev.launchrig.fixture\n---\n- launchApp\n", "utf8");
    await writeFile(
      path.join(directory, "launchrig.yml"),
      [
        "version: 1",
        "project:",
        "  name: Fixture",
        "  packageName: dev.launchrig.fixture",
        "  apk: ./app.apk",
        "  install: true",
        "  installPolicy: if-missing",
        "target:",
        "  network: devnet",
        "device:",
        "  requirePhysical: true",
        "  minimumApiLevel: 26",
        "wallet:",
        "  mode: mock-mwa",
        "  packageName: com.solana.mwallet",
        "  apk: ./wallet.apk",
        "  install: true",
        "  installPolicy: if-missing",
        "scenarios:",
        "  - id: authorize",
        "    kind: mwa-authorize",
        "    name: Authorize",
        "    flow: ./authorize.yaml",
        "  - id: siws",
        "    kind: mwa-siws",
        "    name: SIWS",
        "    flow: ./authorize.yaml",
        "  - id: sign-message",
        "    kind: mwa-sign-message",
        "    name: Sign message",
        "    flow: ./authorize.yaml",
        "  - id: reject",
        "    kind: mwa-reject",
        "    name: Reject",
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
    const config = await loadConfig(path.join(directory, "launchrig.yml"));
    const output = await runLaunchRig(config, { adbPath: adb, maestroPath: maestro });
    assert.equal(output.exitCode, 0);
    assert.equal(output.report.readiness, "Android/MWA Ready");
    assert.equal(output.report.device?.serial, "***");
    assert.equal(output.report.app.versionName, "2.2.0");
    assert.equal(output.report.wallet?.versionCode, "220");
    const authorize = output.report.checks.find((check) => check.id === "scenario.authorize");
    assert.equal(authorize?.status, "pass");
    assert.equal(authorize?.artifacts?.length, 1);
    assert.ok(authorize?.artifacts?.[0]?.endsWith("/scenarios/authorize/maestro-junit.xml"));
    assert.ok(
      output.report.checks.some(
        (check) => check.id === "app.install" && check.summary.includes("skipped by if-missing"),
      ),
    );
    assert.ok(
      output.report.checks.some(
        (check) => check.id === "wallet.install" && check.summary.includes("skipped by if-missing"),
      ),
    );
    await assert.rejects(() =>
      access(path.join(path.dirname(output.artifacts.json), "scenarios", "authorize", "maestro-artifacts")),
    );

    const failedOutput = await runLaunchRig(config, {
      adbPath: adb,
      maestroPath: maestro,
      env: { ...process.env, LAUNCHRIG_TEST_MAESTRO_FAIL: "1" },
    });
    assert.equal(failedOutput.exitCode, 1);
    const failedAuthorize = failedOutput.report.checks.find((check) => check.id === "scenario.authorize");
    assert.equal(failedAuthorize?.status, "fail");
    assert.match(failedAuthorize?.details ?? "", /\*\*\*/);
    assert.doesNotMatch(failedAuthorize?.details ?? "", /A1F0/i);
    assert.doesNotMatch(JSON.stringify(failedOutput.report), /A1F0/i);

    config.project.installPolicy = "always";
    config.wallet.installPolicy = "always";
    process.env.LAUNCHRIG_TEST_ADB_INSTALL_FAIL = "1";
    try {
      const failedInstallOutput = await runLaunchRig(config, { adbPath: adb, maestroPath: maestro });
      assert.equal(failedInstallOutput.exitCode, 1);
      for (const checkId of ["app.install", "wallet.install"]) {
        const installCheck = failedInstallOutput.report.checks.find((check) => check.id === checkId);
        assert.equal(installCheck?.status, "fail");
        assert.match(installCheck?.details ?? "", /\*\*\*/);
        assert.doesNotMatch(installCheck?.details ?? "", /A1F0/i);
      }
      assert.doesNotMatch(JSON.stringify(failedInstallOutput.report), /A1F0/i);
    } finally {
      delete process.env.LAUNCHRIG_TEST_ADB_INSTALL_FAIL;
    }

    const missingDeviceOutput = await runLaunchRig(config, {
      adbPath: adb,
      maestroPath: maestro,
      deviceSerial: "BEEF",
    });
    assert.equal(missingDeviceOutput.exitCode, 3);
    const deviceCheck = missingDeviceOutput.report.checks.find((check) => check.id === "device.connected");
    assert.equal(deviceCheck?.status, "fail");
    assert.match(deviceCheck?.summary ?? "", /\*\*\*/);
    assert.doesNotMatch(JSON.stringify(missingDeviceOutput.report), /BEEF/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
