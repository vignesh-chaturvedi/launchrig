import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MaestroClient, minimalMaestroEnvironment } from "../src/runner/maestro.js";

test("Maestro receives only the environment needed for local Android execution", () => {
  const environment = minimalMaestroEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/safe/home",
      JAVA_HOME: "/safe/java",
      ANDROID_HOME: "/safe/android",
      SECRET_TOKEN: "must-not-cross-boundary",
      API_KEY: "must-not-cross-boundary",
    },
    "/safe/platform-tools",
  );
  assert.equal(environment.PATH, "/safe/platform-tools" + path.delimiter + "/usr/bin");
  assert.equal(environment.HOME, "/safe/home");
  assert.equal(environment.JAVA_HOME, "/safe/java");
  assert.equal(environment.SECRET_TOKEN, undefined);
  assert.equal(environment.API_KEY, undefined);
  assert.equal(environment.MAESTRO_CLI_NO_ANALYTICS, "true");
});

test("Maestro raw artifacts stay in private temporary storage and only sanitized JUnit is retained", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-maestro-test-"));
  let rawDirectory = "";
  try {
    const client = new MaestroClient("maestro", async (command, args) => {
      const outputIndex = args.indexOf("--output");
      const debugIndex = args.indexOf("--test-output-dir");
      const rawJunit = args[outputIndex + 1] ?? "";
      const debugDirectory = args[debugIndex + 1] ?? "";
      rawDirectory = path.dirname(rawJunit);
      await mkdir(debugDirectory, { recursive: true });
      await writeFile(path.join(debugDirectory, "screenshot.png"), "private", "utf8");
      await writeFile(rawJunit, '<testsuite name="A1F0 publisher-secret-token"/>', "utf8");
      return {
        command,
        args,
        exitCode: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        durationMs: 1,
      };
    });

    const outputDirectory = path.join(directory, "retained");
    await client.runFlow({
      serial: "A1F0",
      flowPath: path.join(directory, "flow.yaml"),
      outputDirectory,
      timeoutMs: 1000,
      redactPatterns: ["publisher-secret-token"],
      env: {},
    });

    assert.notEqual(rawDirectory, outputDirectory);
    await assert.rejects(() => access(rawDirectory));
    const retained = await readFile(path.join(outputDirectory, "maestro-junit.xml"), "utf8");
    assert.doesNotMatch(retained, /A1F0|publisher-secret-token/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
