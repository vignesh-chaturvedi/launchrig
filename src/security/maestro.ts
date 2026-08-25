import { maskIdentifier } from "../device/privacy.js";
import { redactText } from "./redact.js";

export function sanitizeMaestroJunit(source: string, serial: string, patterns: string[] = []): string {
  const maskedSerial = maskIdentifier(serial);
  const withoutSelectedSerial = serial ? source.replaceAll(serial, maskedSerial) : source;
  const withoutOtherDeviceIds = withoutSelectedSerial.replace(
    /(\bdevice=)(["'])([^"']*)(\2)/g,
    (_match, prefix: string, quote: string, value: string) =>
      prefix + quote + maskIdentifier(value) + quote,
  );
  return redactText(withoutOtherDeviceIds, patterns).value;
}
