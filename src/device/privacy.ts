import type { DeviceSnapshot } from "../types.js";

export function maskIdentifier(value: string): string {
  if (value.length <= 4) return "***";
  return "***" + value.slice(-4);
}

export function publicDeviceSnapshot(snapshot: DeviceSnapshot): Omit<DeviceSnapshot, "serial"> & { serial: string } {
  return { ...snapshot, serial: maskIdentifier(snapshot.serial) };
}
