import type { AndroidDevice, DeviceSnapshot, PackageSnapshot } from "../types.js";
import { runProcess, type ProcessOptions, type ProcessResult } from "../utils/process.js";

export type AdbRunner = (command: string, args: string[], options?: ProcessOptions) => Promise<ProcessResult>;

export class AdbCommandError extends Error {
  readonly result: ProcessResult;

  constructor(action: string, result: ProcessResult) {
    const stderr = result.stderr.toString("utf8").trim();
    super(action + " failed with exit code " + result.exitCode + (stderr ? ": " + stderr : ""));
    this.name = "AdbCommandError";
    this.result = result;
  }
}

export function parseAdbDevices(output: string): AndroidDevice[] {
  const devices: AndroidDevice[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("List of devices") || line.startsWith("* daemon")) continue;
    const tokens = line.split(/\s+/);
    const serial = tokens[0];
    const state = tokens[1];
    if (!serial || !state) continue;
    const metadata: Record<string, string> = {};
    for (const token of tokens.slice(2)) {
      const separator = token.indexOf(":");
      if (separator > 0) metadata[token.slice(0, separator)] = token.slice(separator + 1);
    }
    const model = metadata.model;
    const product = metadata.product;
    const device = metadata.device;
    const isEmulator =
      serial.startsWith("emulator-") ||
      [model, product, device].some((value) => value?.toLowerCase().includes("emulator") || value?.includes("sdk_gphone"));
    devices.push({
      serial,
      state,
      isEmulator,
      ...(model ? { model } : {}),
      ...(product ? { product } : {}),
      ...(device ? { device } : {}),
      ...(metadata.transport_id ? { transportId: metadata.transport_id } : {}),
      ...(metadata.usb ? { usb: metadata.usb } : {}),
    });
  }
  return devices;
}

export class DeviceSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceSelectionError";
  }
}

export function selectDevice(
  devices: AndroidDevice[],
  requestedSerial: string | undefined,
  requirePhysical: boolean,
): AndroidDevice {
  if (requestedSerial) {
    const requested = devices.find((device) => device.serial === requestedSerial);
    if (!requested) throw new DeviceSelectionError("ADB device " + requestedSerial + " was not found");
    if (requested.state !== "device") {
      const hint = requested.state === "unauthorized" ? " Accept the USB debugging prompt on the phone." : "";
      throw new DeviceSelectionError("ADB device " + requestedSerial + " is " + requested.state + "." + hint);
    }
    if (requirePhysical && requested.isEmulator) {
      throw new DeviceSelectionError("ADB device " + requestedSerial + " is an emulator; a physical phone is required");
    }
    return requested;
  }

  const authorized = devices.filter((device) => device.state === "device");
  const eligible = requirePhysical ? authorized.filter((device) => !device.isEmulator) : authorized;
  if (eligible.length === 1) return eligible[0] as AndroidDevice;
  if (eligible.length > 1) {
    throw new DeviceSelectionError(
      "Multiple eligible Android devices are connected. Select one with --device SERIAL: " +
        eligible.map((device) => device.serial).join(", "),
    );
  }
  const unauthorized = devices.filter((device) => device.state === "unauthorized");
  if (unauthorized.length > 0) {
    throw new DeviceSelectionError("The connected phone is unauthorized. Unlock it and accept the USB debugging prompt.");
  }
  if (requirePhysical && authorized.some((device) => device.isEmulator)) {
    throw new DeviceSelectionError("Only an emulator is connected, but this run requires a physical Android phone.");
  }
  throw new DeviceSelectionError("No authorized Android phone is connected over ADB.");
}

function parseProperties(output: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]: \[(.*)\]$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) properties[match[1]] = match[2];
  }
  return properties;
}

function parseBatteryLevel(output: string): number | undefined {
  const match = /^\s*level:\s*(\d+)\s*$/m.exec(output);
  return match ? Number.parseInt(match[1] as string, 10) : undefined;
}

function parseAvailableDataKb(output: string): number | undefined {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  const last = lines.at(-1);
  if (!last) return undefined;
  const tokens = last.trim().split(/\s+/);
  const available = tokens[3];
  if (!available || !/^\d+$/.test(available)) return undefined;
  return Number.parseInt(available, 10);
}

export class AdbClient {
  constructor(
    readonly binary: string,
    private readonly runner: AdbRunner = runProcess,
  ) {}

  private async execute(args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
    return await this.runner(this.binary, args, options);
  }

  async version(): Promise<string> {
    const result = await this.execute(["version"]);
    if (result.exitCode !== 0) throw new AdbCommandError("Reading ADB version", result);
    return result.stdout.toString("utf8").trim();
  }

  async listDevices(): Promise<AndroidDevice[]> {
    const result = await this.execute(["devices", "-l"]);
    if (result.exitCode !== 0) throw new AdbCommandError("Listing Android devices", result);
    return parseAdbDevices(result.stdout.toString("utf8"));
  }

  async shell(serial: string, args: string[], timeoutMs = 30000): Promise<ProcessResult> {
    return await this.execute(["-s", serial, "shell", ...args], { timeoutMs });
  }

  async snapshot(device: AndroidDevice): Promise<DeviceSnapshot> {
    const [propertiesResult, batteryResult, storageResult] = await Promise.all([
      this.shell(device.serial, ["getprop"]),
      this.shell(device.serial, ["dumpsys", "battery"]),
      this.shell(device.serial, ["df", "-k", "/data"]),
    ]);
    if (propertiesResult.exitCode !== 0) throw new AdbCommandError("Reading Android properties", propertiesResult);
    const properties = parseProperties(propertiesResult.stdout.toString("utf8"));
    const emulatorProperty = properties["ro.kernel.qemu"] === "1";
    const batteryLevel =
      batteryResult.exitCode === 0 ? parseBatteryLevel(batteryResult.stdout.toString("utf8")) : undefined;
    const availableDataKb =
      storageResult.exitCode === 0 ? parseAvailableDataKb(storageResult.stdout.toString("utf8")) : undefined;
    return {
      serial: device.serial,
      manufacturer: properties["ro.product.manufacturer"] ?? "unknown",
      model: properties["ro.product.model"] ?? device.model ?? "unknown",
      androidVersion: properties["ro.build.version.release"] ?? "unknown",
      apiLevel: Number.parseInt(properties["ro.build.version.sdk"] ?? "0", 10),
      abi: properties["ro.product.cpu.abi"] ?? "unknown",
      securityPatch: properties["ro.build.version.security_patch"] ?? "unknown",
      isEmulator: device.isEmulator || emulatorProperty,
      ...(batteryLevel !== undefined ? { batteryLevel } : {}),
      ...(availableDataKb !== undefined ? { availableDataKb } : {}),
    };
  }

  async isPackageInstalled(serial: string, packageName: string): Promise<boolean> {
    const result = await this.shell(serial, ["pm", "path", packageName]);
    return result.exitCode === 0 && result.stdout.toString("utf8").includes("package:");
  }

  async packageSnapshot(serial: string, packageName: string): Promise<PackageSnapshot> {
    const result = await this.shell(serial, ["dumpsys", "package", packageName]);
    if (result.exitCode !== 0) return { packageName };
    const output = result.stdout.toString("utf8");
    const versionName = /^\s*versionName=(.+)$/m.exec(output)?.[1]?.trim();
    const versionCode = /^\s*versionCode=(\d+)/m.exec(output)?.[1]?.trim();
    const packagePath = await this.shell(serial, ["pm", "path", packageName]);
    const installedApkPath = packagePath.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => (line.startsWith("package:") ? line.slice("package:".length).trim() : ""))
      .find((entry) => entry.endsWith("/base.apk"));
    let apkSha256: string | undefined;
    if (
      packagePath.exitCode === 0 &&
      installedApkPath &&
      /^\/data\/app\/[A-Za-z0-9._~+=,@%:/-]+\.apk$/.test(installedApkPath)
    ) {
      let digest = await this.shell(serial, ["sha256sum", installedApkPath]);
      if (digest.exitCode !== 0) digest = await this.shell(serial, ["toybox", "sha256sum", installedApkPath]);
      const candidate = /^([a-fA-F0-9]{64})\s/.exec(digest.stdout.toString("utf8"))?.[1];
      if (digest.exitCode === 0 && candidate) apkSha256 = candidate.toLowerCase();
    }
    return {
      packageName,
      ...(versionName ? { versionName } : {}),
      ...(versionCode ? { versionCode } : {}),
      ...(apkSha256 ? { apkSha256 } : {}),
    };
  }

  async installApk(serial: string, apkPath: string): Promise<ProcessResult> {
    return await this.execute(["-s", serial, "install", "-r", apkPath], { timeoutMs: 180000 });
  }

  async forceStopPackage(serial: string, packageName: string): Promise<ProcessResult> {
    return await this.shell(serial, ["am", "force-stop", packageName]);
  }

  async screenshot(serial: string): Promise<ProcessResult> {
    return await this.execute(["-s", serial, "exec-out", "screencap", "-p"], {
      timeoutMs: 30000,
      maxOutputBytes: 20 * 1024 * 1024,
    });
  }

  async logcat(serial: string, lines: number, packageName: string): Promise<ProcessResult> {
    const pid = await this.shell(serial, ["pidof", packageName]);
    const pidValue = pid.exitCode === 0 ? pid.stdout.toString("utf8").trim().split(/\s+/)[0] : undefined;
    const args = ["-s", serial, "logcat", "-d", "-t", String(lines)];
    if (!pidValue || !/^\d+$/.test(pidValue)) {
      return {
        command: this.binary,
        args,
        exitCode: 1,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("Target app PID is unavailable; package-filtered logcat was not captured."),
        durationMs: pid.durationMs,
      };
    }
    args.push("--pid", pidValue);
    const capture = await this.execute(args, { timeoutMs: 30000, maxOutputBytes: 512 * 1024 });
    if (capture.exitCode !== 0) return capture;
    const pidAfterCapture = await this.shell(serial, ["pidof", packageName]);
    const pidAfterValue =
      pidAfterCapture.exitCode === 0 ? pidAfterCapture.stdout.toString("utf8").trim().split(/\s+/)[0] : undefined;
    if (pidAfterValue !== pidValue) {
      return {
        command: this.binary,
        args,
        exitCode: 1,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("Target app PID changed during logcat capture; captured output was discarded."),
        durationMs: capture.durationMs + pidAfterCapture.durationMs,
      };
    }
    return capture;
  }
}
