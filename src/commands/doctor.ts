import { loadConfig, validateConfigPaths } from "../config/load.js";
import { AdbClient, selectDevice } from "../device/adb.js";
import { maskIdentifier, maskKnownIdentifiers } from "../device/privacy.js";
import { verifyManagedWalletArtifact } from "../security/wallet-artifact.js";
import type { DeviceSnapshot } from "../types.js";
import { adbCandidates, findExecutable, maestroCandidates } from "../utils/executable.js";

export interface DoctorOptions {
  configPath?: string;
  deviceSerial?: string;
  adbPath?: string;
  maestroPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DoctorOutput {
  ok: boolean;
  adb: { path?: string; version?: string };
  maestro: { required: boolean; path?: string; installed: boolean };
  device?: Omit<DeviceSnapshot, "serial"> & { serial: string };
  packages: Array<{ packageName: string; installed: boolean; willInstall: boolean; role: "app" | "wallet" }>;
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
      issues: ["ADB was not found. Install Android Platform Tools or set LAUNCHRIG_ADB_PATH."],
    };
  }

  const adb = new AdbClient(adbPath);
  const version = await adb.version();
  let snapshot: DeviceSnapshot | undefined;
  const deviceIdentifiers = [options.deviceSerial ?? env.ANDROID_SERIAL ?? ""];
  try {
    const devices = await adb.listDevices();
    deviceIdentifiers.push(...devices.map((device) => device.serial));
    const selected = selectDevice(
      devices,
      options.deviceSerial ?? env.ANDROID_SERIAL,
      config?.device.requirePhysical ?? true,
    );
    snapshot = await adb.snapshot(selected);
    if (config && snapshot.apiLevel < config.device.minimumApiLevel) {
      issues.push("Device API " + snapshot.apiLevel + " is below configured minimum " + config.device.minimumApiLevel + ".");
    }
    if (config) {
      const appInstalled = await adb.isPackageInstalled(selected.serial, config.project.packageName);
      packages.push({
        packageName: config.project.packageName,
        installed: appInstalled,
        willInstall:
          config.project.install &&
          Boolean(config.resolvedApk) &&
          (!appInstalled || config.project.installPolicy === "always"),
        role: "app",
      });
      if (config.wallet.packageName) {
        const walletInstalled = await adb.isPackageInstalled(selected.serial, config.wallet.packageName);
        packages.push({
          packageName: config.wallet.packageName,
          installed: walletInstalled,
          willInstall:
            config.wallet.install &&
            Boolean(config.resolvedWalletApk) &&
            (!walletInstalled || config.wallet.installPolicy === "always"),
          role: "wallet",
        });
      }
      const managedWallet = packages.find((entry) => entry.role === "wallet");
      if (managedWallet?.willInstall && config.resolvedWalletApk && config.wallet.packageName) {
        const verification = await verifyManagedWalletArtifact(config.wallet.packageName, config.resolvedWalletApk);
        if (!verification.valid) {
          managedWallet.willInstall = false;
          if (verification.actualSha256) {
            issues.push("Managed test-wallet APK does not match its pinned SHA-256 contract.");
          } else {
            issues.push("Managed test-wallet APK could not be verified against its pinned SHA-256 contract.");
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

  return {
    ok: issues.length === 0,
    adb: { path: adbPath, version },
    maestro: { required: maestroRequired, installed: Boolean(maestroPath), ...(maestroPath ? { path: maestroPath } : {}) },
    ...(snapshot ? { device: { ...snapshot, serial: maskIdentifier(snapshot.serial) } } : {}),
    packages,
    issues,
  };
}
