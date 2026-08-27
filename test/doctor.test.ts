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
