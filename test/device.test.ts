import assert from "node:assert/strict";
import test from "node:test";
import { AdbClient, DeviceSelectionError, parseAdbDevices, selectDevice } from "../src/device/adb.js";
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
