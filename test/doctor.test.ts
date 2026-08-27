import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctor } from "../src/commands/doctor.js";

const MULTI_DEVICE_ADB = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("Android Debug Bridge version 1.0.41");
} else if (args[0] === "devices") {
  console.log("List of devices attached\\nPHONE-ALPHA-1234 device model:Alpha\\nPHONE-BETA-5678 device model:Beta");
} else {
  process.exitCode = 1;
}
`;

function readyAdb(walletSha256: string, emulatorProperty = false): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
const walletSha256 = ${JSON.stringify(walletSha256)};
const emulatorProperty = ${JSON.stringify(emulatorProperty)};
if (args[0] === "version") {
  console.log("Android Debug Bridge version 1.0.41");
} else if (args[0] === "devices") {
  console.log("List of devices attached\\nPHONE-PREFLIGHT-1234 device model:PublisherPhone");
} else if (args[0] === "-s" && args[2] === "shell") {
  const shell = args.slice(3);
  if (shell[0] === "getprop") {
    console.log("[ro.product.manufacturer]: [Publisher]\\n[ro.product.model]: [Phone]\\n[ro.build.version.release]: [16]\\n[ro.build.version.sdk]: [36]\\n[ro.product.cpu.abi]: [arm64-v8a]\\n[ro.build.version.security_patch]: [2026-08-01]" + (emulatorProperty ? "\\n[ro.kernel.qemu]: [1]" : ""));
  } else if (shell[0] === "dumpsys" && shell[1] === "battery") {
    console.log("level: 90");
  } else if (shell[0] === "df") {
    console.log("Filesystem 1K-blocks Used Available Use% Mounted on\\n/data 100000 50000 50000 50% /data");
  } else if (shell[0] === "pm" && shell[1] === "path") {
    const packageName = shell[2];
    console.log("package:/data/app/~~launchrig/" + packageName + "-test/base.apk");
  } else if (shell[0] === "dumpsys" && shell[1] === "package") {
    console.log("  versionName=1.0.0\\n  versionCode=1 minSdk=26");
  } else if (shell[0] === "sha256sum") {
    const digest = shell[1].includes("com.solana.mwallet") ? walletSha256 : "a".repeat(64);
    console.log(digest + "  " + shell[1]);
  } else {
    process.exitCode = 1;
  }
} else {
  process.exitCode = 1;
}
`;
}

const READY_MAESTRO = `#!/usr/bin/env node
if (process.argv[2] === "--version") console.log("2.8.0");
else process.exitCode = 1;
`;

async function writeDoctorConfig(directory: string): Promise<string> {
  await writeFile(
    path.join(directory, "authorize.yaml"),
    "appId: com.publisher.mobile\n---\n- assertVisible:\n    id: publisher-ready\n",
    "utf8",
  );
  const configPath = path.join(directory, "launchrig.yml");
  await writeFile(
    configPath,
    [
      "version: 1",
      "project:",
      "  name: Publisher Mobile",
      "  packageName: com.publisher.mobile",
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

test("doctor masks every device identifier in selection errors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-doctor-"));
  try {
    const adbPath = path.join(directory, "adb");
    await writeFile(adbPath, MULTI_DEVICE_ADB, "utf8");
    await chmod(adbPath, 0o755);
    const output = await doctor({ adbPath, env: { PATH: "" } });
    const serialized = JSON.stringify(output);
    assert.equal(output.ok, false);
    assert.match(serialized, /\*\*\*/);
    assert.doesNotMatch(serialized, /PHONE-ALPHA-1234/);
    assert.doesNotMatch(serialized, /PHONE-BETA-5678/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("strict doctor invokes Maestro and verifies installed app and wallet hashes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-doctor-strict-"));
  try {
    const adbPath = path.join(directory, "adb");
    const maestroPath = path.join(directory, "maestro");
    const configPath = await writeDoctorConfig(directory);
    const expectedWalletSha256 = "b9b28b4936f388f615febc493e0af5c7e8c40002de4a3cddbef4f52315a9ef3b";
    await writeFile(adbPath, readyAdb(expectedWalletSha256), "utf8");
    await writeFile(maestroPath, READY_MAESTRO, "utf8");
    await chmod(adbPath, 0o755);
    await chmod(maestroPath, 0o755);

    const output = await doctor({
      configPath,
      adbPath,
      maestroPath,
      verifyInstalledArtifactHashes: true,
      env: { PATH: process.env.PATH ?? "" },
    });
    assert.equal(output.ok, true, JSON.stringify(output, null, 2));
    assert.equal(output.maestro.version, "2.8.0");
    assert.ok(output.packages.every((entry) => entry.binaryReady === true));
    assert.equal(output.packages.find((entry) => entry.role === "app")?.installedSha256, "a".repeat(64));
    assert.equal(output.packages.find((entry) => entry.role === "wallet")?.installedSha256, expectedWalletSha256);
    assert.doesNotMatch(JSON.stringify(output), /PHONE-PREFLIGHT-1234/);

    await writeFile(adbPath, readyAdb("c".repeat(64)), "utf8");
    await chmod(adbPath, 0o755);
    const mismatch = await doctor({
      configPath,
      adbPath,
      maestroPath,
      verifyInstalledArtifactHashes: true,
      env: { PATH: process.env.PATH ?? "" },
    });
    assert.equal(mismatch.ok, false);
    assert.ok(mismatch.issues.some((issue) => issue.includes("Installed test-wallet APK")));

    await writeFile(adbPath, readyAdb(expectedWalletSha256, true), "utf8");
    await chmod(adbPath, 0o755);
    const emulator = await doctor({
      configPath,
      adbPath,
      maestroPath,
      verifyInstalledArtifactHashes: true,
      env: { PATH: process.env.PATH ?? "" },
    });
    assert.equal(emulator.ok, false);
    assert.ok(emulator.issues.some((issue) => issue.includes("reports emulator properties")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
