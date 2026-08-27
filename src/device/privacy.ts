import type { DeviceSnapshot } from "../types.js";

export function maskIdentifier(value: string): string {
  if (value.length <= 4) return "***";
  return "***" + value.slice(-4);
}

export function maskKnownIdentifiers(value: string, identifiers: readonly string[]): string {
  let masked = value;
  for (const identifier of identifiers.filter(Boolean).sort((left, right) => right.length - left.length)) {
    const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    masked = masked.replace(new RegExp(escapedIdentifier, "gi"), "***");
  }
  return masked;
}

export function publicDeviceSnapshot(snapshot: DeviceSnapshot): Omit<DeviceSnapshot, "serial"> & { serial: string } {
  return { ...snapshot, serial: maskIdentifier(snapshot.serial) };
}
