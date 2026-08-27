import assert from "node:assert/strict";
import test from "node:test";
import { AdbClient, DeviceSelectionError, parseAdbDevices, selectDevice } from "../src/device/adb.js";
import { maskKnownIdentifiers } from "../src/device/privacy.js";
import type { ProcessResult } from "../src/utils/process.js";

const SAMPLE = [
  "List of devices attached",
  "RF8M31ABC device usb:1-2 product:r8q model:Galaxy_S20 device:r8q transport_id:2",
  "emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:3",
  "ZX1G22 unauthorized usb:1-4 transport_id:4",
  "",
].join("\n");

test("ADB parser preserves authorization state and detects emulators", () => {
  const devices = parseAdbDevices(SAMPLE);
  assert.equal(devices.length, 3);
  assert.equal(devices[0]?.model, "Galaxy_S20");
  assert.equal(devices[0]?.isEmulator, false);
  assert.equal(devices[1]?.isEmulator, true);
  assert.equal(devices[2]?.state, "unauthorized");
});

test("device selector chooses the sole authorized physical phone", () => {
  const selected = selectDevice(parseAdbDevices(SAMPLE), undefined, true);
  assert.equal(selected.serial, "RF8M31ABC");
});

test("device selector never silently chooses among multiple phones", () => {
  const devices = parseAdbDevices(
    "List of devices attached\nONE device model:One\nTWO device model:Two\n",
  );
  assert.throws(
    () => selectDevice(devices, undefined, true),
    (error: unknown) => error instanceof DeviceSelectionError && error.message.includes("Multiple"),
  );
});

test("unauthorized phone produces a useful instruction", () => {
  const devices = parseAdbDevices("List of devices attached\nPHONE unauthorized usb:1-1\n");
  assert.throws(
    () => selectDevice(devices, undefined, true),
    (error: unknown) => error instanceof DeviceSelectionError && error.message.includes("USB debugging"),
  );
});

test("reference-wallet reset is package-scoped and never clears data", async () => {
  const calls: string[][] = [];
  const runner = async (_command: string, args: string[]): Promise<ProcessResult> => {
    calls.push(args);
    return {
      command: "adb",
      args,
      exitCode: 0,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      durationMs: 1,
    };
  };
  const adb = new AdbClient("adb", runner);
  await adb.forceStopPackage("PHONE123", "com.solana.mobilewalletadapter.fakewallet");
  assert.deepEqual(calls, [
    ["-s", "PHONE123", "shell", "am", "force-stop", "com.solana.mobilewalletadapter.fakewallet"],
  ]);
  assert.equal(calls.flat().includes("clear"), false);
});

test("logcat refuses whole-device capture when the app PID is unavailable", async () => {
  const calls: string[][] = [];
  const runner = async (_command: string, args: string[]): Promise<ProcessResult> => {
    calls.push(args);
    return {
      command: "adb",
      args,
      exitCode: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      durationMs: 1,
    };
  };
  const result = await new AdbClient("adb", runner).logcat("PHONE123", 200, "com.publisher.app");
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr.toString("utf8"), /package-filtered/);
  assert.deepEqual(calls, [["-s", "PHONE123", "shell", "pidof", "com.publisher.app"]]);
});

test("logcat capture is restricted to the selected app PID", async () => {
  const calls: string[][] = [];
  const runner = async (_command: string, args: string[]): Promise<ProcessResult> => {
    calls.push(args);
    return {
      command: "adb",
      args,
      exitCode: 0,
      signal: null,
      stdout: Buffer.from(calls.length === 2 ? "publisher log\n" : "123 456\n"),
      stderr: Buffer.alloc(0),
      durationMs: 1,
    };
  };
  const result = await new AdbClient("adb", runner).logcat("PHONE123", 75, "com.publisher.app");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls[1], ["-s", "PHONE123", "logcat", "-d", "-t", "75", "--pid", "123"]);
  assert.deepEqual(calls[2], ["-s", "PHONE123", "shell", "pidof", "com.publisher.app"]);
});

test("logcat discards output when the app PID changes during capture", async () => {
  let call = 0;
  const runner = async (_command: string, args: string[]): Promise<ProcessResult> => {
    call += 1;
    return {
      command: "adb",
      args,
      exitCode: 0,
      signal: null,
      stdout: Buffer.from(call === 1 ? "123\n" : call === 2 ? "private output\n" : "456\n"),
      stderr: Buffer.alloc(0),
      durationMs: 1,
    };
  };
  const result = await new AdbClient("adb", runner).logcat("PHONE123", 75, "com.publisher.app");
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr.toString("utf8"), /discarded/);
});

test("known device identifiers are masked without exposing their values", () => {
  const masked = maskKnownIdentifiers("Missing PHONE123; connected PHONE456", ["PHONE123", "PHONE456", ""]);
  assert.equal(masked, "Missing ***; connected ***");
});
