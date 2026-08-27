import path from "node:path";
import { loadConfig, validateConfigPaths } from "../config/load.js";
import { AdbClient, selectDevice } from "../device/adb.js";
import { maskIdentifier, maskKnownIdentifiers } from "../device/privacy.js";
import { MaestroClient, minimalMaestroEnvironment } from "../runner/maestro.js";
import {
  managedWalletExpectedSha256,
  sha256File,
  verifyManagedWalletArtifact,
} from "../security/wallet-artifact.js";
import type { DeviceSnapshot } from "../types.js";
import { adbCandidates, findExecutable, maestroCandidates } from "../utils/executable.js";

export interface DoctorOptions {
  configPath?: string;
  deviceSerial?: string;
  adbPath?: string;
  maestroPath?: string;
  verifyInstalledArtifactHashes?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface DoctorPackageOutput {
  packageName: string;
  installed: boolean;
  willInstall: boolean;
  role: "app" | "wallet";
  installedSha256?: string;
  configuredSha256?: string;
  expectedSha256?: string;
  binaryReady?: boolean;
}

export interface DoctorOutput {
  ok: boolean;
  adb: { path?: string; version?: string };
  maestro: { required: boolean; path?: string; installed: boolean; version?: string };
  device?: Omit<DeviceSnapshot, "serial"> & { serial: string };
  packages: DoctorPackageOutput[];
  issues: string[];
}

export async function doctor(options: DoctorOptions = {}): Promise<DoctorOutput> {
  const env = options.env ?? process.env;
  const config = options.configPath ? await loadConfig(options.configPath) : undefined;
  const issues: string[] = config ? await validateConfigPaths(config) : [];
  const packages: DoctorOutput["packages"] = [];
  const adbPath = await findExecutable(
    "adb",
    options.adbPath ?? config?.tooling.adb ?? env.LAUNCHRIG_ADB_PATH ?? env.LAUNCHRIG_ADB,
    adbCandidates(env),
    env,
  );
  if (!adbPath) {
    return {
      ok: false,
      adb: {},
      maestro: { required: (config?.scenarios.length ?? 0) > 0, installed: false },
      packages,
      issues: [...issues, "ADB was not found. Install Android Platform Tools or set LAUNCHRIG_ADB_PATH."],
    };
  }

  const adb = new AdbClient(adbPath);
  let version: string | undefined;
  let snapshot: DeviceSnapshot | undefined;
  const deviceIdentifiers = [options.deviceSerial ?? env.ANDROID_SERIAL ?? ""];
  try {
    version = await adb.version();
    const devices = await adb.listDevices();
    deviceIdentifiers.push(...devices.map((device) => device.serial));
    const selected = selectDevice(
      devices,
      options.deviceSerial ?? env.ANDROID_SERIAL,
      config?.device.requirePhysical ?? true,
    );
    snapshot = await adb.snapshot(selected);
    if ((config?.device.requirePhysical ?? true) && snapshot.isEmulator) {
      issues.push("Selected Android device reports emulator properties; a physical phone is required.");
    }
    if (config && snapshot.apiLevel < config.device.minimumApiLevel) {
      issues.push("Device API " + snapshot.apiLevel + " is below configured minimum " + config.device.minimumApiLevel + ".");
    }
    if (config) {
      const appInstalled = await adb.isPackageInstalled(selected.serial, config.project.packageName);
      const appWillInstall =
        config.project.install &&
        Boolean(config.resolvedApk) &&
        (!appInstalled || config.project.installPolicy === "always");
      const appSnapshot =
        options.verifyInstalledArtifactHashes && appInstalled
          ? await adb.packageSnapshot(selected.serial, config.project.packageName)
          : undefined;
      let configuredAppSha256: string | undefined;
      if (options.verifyInstalledArtifactHashes && config.resolvedApk) {
        try {
          configuredAppSha256 = await sha256File(config.resolvedApk);
        } catch {
          issues.push("Configured app APK could not be hashed for pilot readiness.");
        }
      }
      const appBinaryReady = options.verifyInstalledArtifactHashes
        ? appWillInstall
          ? Boolean(configuredAppSha256)
          : Boolean(
              appInstalled &&
                appSnapshot?.apkSha256 &&
                (!config.resolvedApk ||
                  (configuredAppSha256 && appSnapshot.apkSha256 === configuredAppSha256)),
            )
        : undefined;
      const appEntry: DoctorPackageOutput = {
        packageName: config.project.packageName,
        installed: appInstalled,
        willInstall: appWillInstall,
        role: "app",
        ...(appSnapshot?.apkSha256 ? { installedSha256: appSnapshot.apkSha256 } : {}),
        ...(configuredAppSha256 ? { configuredSha256: configuredAppSha256 } : {}),
        ...(appBinaryReady !== undefined ? { binaryReady: appBinaryReady } : {}),
      };
      packages.push(appEntry);
      if (options.verifyInstalledArtifactHashes && appInstalled && !appWillInstall && !appBinaryReady) {
        issues.push(
          config.resolvedApk
            ? "Installed app APK does not match the configured artifact or its hash could not be captured."
            : "Installed app APK hash could not be captured for pilot readiness.",
        );
      }
      if (config.wallet.packageName) {
        const walletInstalled = await adb.isPackageInstalled(selected.serial, config.wallet.packageName);
        const walletWillInstall =
          config.wallet.install &&
          Boolean(config.resolvedWalletApk) &&
          (!walletInstalled || config.wallet.installPolicy === "always");
        const expectedWalletSha256 = managedWalletExpectedSha256(config.wallet.packageName);
        const walletSnapshot =
          options.verifyInstalledArtifactHashes && walletInstalled
            ? await adb.packageSnapshot(selected.serial, config.wallet.packageName)
            : undefined;
        const configuredWalletVerification =
          (options.verifyInstalledArtifactHashes || walletWillInstall) && config.resolvedWalletApk
            ? await verifyManagedWalletArtifact(config.wallet.packageName, config.resolvedWalletApk)
            : undefined;
        const configuredWalletReady = config.resolvedWalletApk
          ? configuredWalletVerification?.valid === true
          : true;
        const walletBinaryReady = options.verifyInstalledArtifactHashes
          ? configuredWalletReady &&
            Boolean(
              expectedWalletSha256 &&
                (walletWillInstall
                  ? configuredWalletVerification?.valid
                  : walletInstalled && walletSnapshot?.apkSha256 === expectedWalletSha256),
            )
          : undefined;
        const walletEntry: DoctorPackageOutput = {
          packageName: config.wallet.packageName,
          installed: walletInstalled,
          willInstall: walletWillInstall,
          role: "wallet",
          ...(walletSnapshot?.apkSha256 ? { installedSha256: walletSnapshot.apkSha256 } : {}),
          ...(configuredWalletVerification?.actualSha256
            ? { configuredSha256: configuredWalletVerification.actualSha256 }
            : {}),
          ...(expectedWalletSha256 ? { expectedSha256: expectedWalletSha256 } : {}),
          ...(walletBinaryReady !== undefined ? { binaryReady: walletBinaryReady } : {}),
        };
        packages.push(walletEntry);
        if (config.resolvedWalletApk && configuredWalletVerification && !configuredWalletVerification.valid) {
          walletEntry.willInstall = false;
          issues.push(
            configuredWalletVerification.actualSha256
              ? "Managed test-wallet APK does not match its pinned SHA-256 contract."
              : "Managed test-wallet APK could not be verified against its pinned SHA-256 contract.",
          );
        }
        if (
          options.verifyInstalledArtifactHashes &&
          walletInstalled &&
          !walletWillInstall &&
          walletSnapshot?.apkSha256 !== expectedWalletSha256
        ) {
          issues.push("Installed test-wallet APK does not match the managed artifact contract.");
        }
        if (
          options.verifyInstalledArtifactHashes &&
          walletWillInstall &&
          !configuredWalletVerification?.valid
        ) {
          if (!issues.some((issue) => issue.includes("Managed test-wallet APK"))) {
            issues.push("Managed test-wallet APK could not be verified for installation.");
          }
        }
      }
      for (const entry of packages) {
        if (!entry.installed && !entry.willInstall) {
          issues.push(entry.role + " package is not installed: " + entry.packageName);
        }
      }
    }
  } catch (error) {
    issues.push(maskKnownIdentifiers(error instanceof Error ? error.message : String(error), deviceIdentifiers));
  }

  const maestroRequired = (config?.scenarios.length ?? 0) > 0;
  const maestroPath = await findExecutable(
    "maestro",
    options.maestroPath ?? config?.tooling.maestro ?? env.LAUNCHRIG_MAESTRO_PATH,
    maestroCandidates(),
    env,
  );
  if (maestroRequired && !maestroPath) issues.push("Maestro is required by configured scenarios but was not found.");
  let maestroVersion: string | undefined;
  if (maestroRequired && maestroPath && options.verifyInstalledArtifactHashes) {
    try {
      const result = await new MaestroClient(maestroPath).version(
        minimalMaestroEnvironment(env, path.dirname(adbPath)),
      );
      if (result.exitCode === 0) {
        maestroVersion = result.stdout.toString("utf8").trim() || "available";
      } else {
        issues.push("Maestro was found but its version check failed.");
      }
    } catch {
      issues.push("Maestro was found but could not be invoked.");
    }
  }

  return {
    ok: issues.length === 0,
    adb: { path: adbPath, ...(version ? { version } : {}) },
    maestro: {
      required: maestroRequired,
      installed: Boolean(maestroPath),
      ...(maestroPath ? { path: maestroPath } : {}),
      ...(maestroVersion ? { version: maestroVersion } : {}),
    },
    ...(snapshot ? { device: { ...snapshot, serial: maskIdentifier(snapshot.serial) } } : {}),
    packages,
    issues,
  };
}
