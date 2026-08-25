#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { ConfigError } from "./config/schema.js";
import { doctor } from "./commands/doctor.js";
import { initProject } from "./commands/init.js";
import {
  FixtureMatrixEnvironmentError,
  runFixtureMatrix,
  type RunFixtureMatrixOutput,
} from "./commands/matrix.js";
import { runProject } from "./commands/run.js";
import { validateProject } from "./commands/validate.js";
import { FixtureMatrixValidationError } from "./fixtures/matrix.js";
import { LAUNCHRIG_VERSION } from "./version.js";

export interface CliIO {
  out(message: string): void;
  error(message: string): void;
}

export interface CliDependencies {
  runFixtureMatrix?: typeof runFixtureMatrix;
}

const defaultIO: CliIO = {
  out: (message) => console.log(message),
  error: (message) => console.error(message),
};

const HELP = [
  "LaunchRig " + LAUNCHRIG_VERSION,
  "",
  "Usage:",
  "  launchrig init [--name NAME] [--package APP_ID] [--force]",
  "  launchrig validate [--config launchrig.yml] [--json]",
  "  launchrig doctor [--config launchrig.yml] [--device SERIAL] [--json]",
  "  launchrig run [--config launchrig.yml] [--device SERIAL] [--scenario ID]",
  "  launchrig matrix [--device SERIAL] [--json]",
  "",
  "Tool overrides:",
  "  --adb PATH       ADB executable (or LAUNCHRIG_ADB_PATH)",
  "  --maestro PATH   Maestro executable (or LAUNCHRIG_MAESTRO_PATH)",
  "",
  "Exit codes: 0 pass, 1 test failure, 2 config/usage, 3 environment/device, 4 internal.",
].join("\n");

function humanMatrix(value: RunFixtureMatrixOutput): string {
  const lines = [
    "LaunchRig fixture matrix: " + (value.evaluation.accepted ? "accepted" : "rejected"),
    "app SHA-256: " + value.provenance.app.sha256,
    "wallet SHA-256: " + value.provenance.wallet.sha256,
  ];
  for (const execution of value.executions) {
    lines.push(
      execution.variant + ": " + execution.output.report.outcome + ", exit " + execution.output.exitCode,
      execution.variant + " JSON: " + execution.output.artifacts.json,
    );
  }
  for (const issue of value.evaluation.issues) lines.push("- " + issue.message);
  return lines.join("\n");
}

function humanDoctor(value: Awaited<ReturnType<typeof doctor>>): string {
  const lines = [value.ok ? "LaunchRig doctor: ready" : "LaunchRig doctor: action required"];
  if (value.adb.path) lines.push("ADB: " + value.adb.path);
  if (value.device) {
    lines.push(
      "Device: " +
        value.device.manufacturer +
        " " +
        value.device.model +
        " · Android " +
        value.device.androidVersion +
        " · API " +
        value.device.apiLevel +
        " · " +
        value.device.serial,
    );
  }
  lines.push("Maestro: " + (value.maestro.installed ? "installed" : value.maestro.required ? "missing" : "optional / not found"));
  for (const entry of value.packages) {
    const state = entry.installed ? "PASS" : entry.willInstall ? "INSTALL ON RUN" : "FAIL";
    lines.push(state + " " + entry.role + ": " + entry.packageName);
  }
  for (const issue of value.issues) lines.push("- " + issue);
  return lines.join("\n");
}

export async function runCli(
  argv: string[],
  io: CliIO = defaultIO,
  dependencies: CliDependencies = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: "string", short: "c", default: "launchrig.yml" },
        device: { type: "string", short: "d" },
        scenario: { type: "string" },
        adb: { type: "string" },
        maestro: { type: "string" },
        json: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        name: { type: "string" },
        package: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    io.error("Run launchrig --help for usage.");
    return 2;
  }

  if (parsed.values.version) {
    io.out(LAUNCHRIG_VERSION);
    return 0;
  }
  const command = parsed.positionals[0] ?? "help";
  if (parsed.values.help || command === "help") {
    io.out(HELP);
    return 0;
  }
  const configPath = typeof parsed.values.config === "string" ? parsed.values.config : "launchrig.yml";
  const device = typeof parsed.values.device === "string" ? parsed.values.device : undefined;
  const scenario = typeof parsed.values.scenario === "string" ? parsed.values.scenario : undefined;
  const adb = typeof parsed.values.adb === "string" ? parsed.values.adb : undefined;
  const maestro = typeof parsed.values.maestro === "string" ? parsed.values.maestro : undefined;
  const projectName = typeof parsed.values.name === "string" ? parsed.values.name : undefined;
  const packageName = typeof parsed.values.package === "string" ? parsed.values.package : undefined;

  try {
    if (command === "init") {
      const files = await initProject({
        cwd: process.cwd(),
        force: parsed.values.force === true,
        ...(projectName ? { projectName } : {}),
        ...(packageName ? { packageName } : {}),
      });
      io.out("LaunchRig initialized:\n" + files.map((file) => "- " + path.relative(process.cwd(), file)).join("\n"));
      return 0;
    }

    if (command === "validate") {
      const validation = await validateProject(configPath);
      if (parsed.values.json) io.out(JSON.stringify(validation, null, 2));
      else {
        io.out(
          validation.valid
            ? "Configuration valid: " + validation.project + " · " + validation.scenarios + " scenario(s)"
            : "Configuration invalid:\n" + validation.issues.map((issue) => "- " + issue).join("\n"),
        );
      }
      return validation.valid ? 0 : 2;
    }

    if (command === "doctor") {
      const output = await doctor({
        configPath,
        ...(device ? { deviceSerial: device } : {}),
        ...(adb ? { adbPath: adb } : {}),
        ...(maestro ? { maestroPath: maestro } : {}),
      });
      io.out(parsed.values.json ? JSON.stringify(output, null, 2) : humanDoctor(output));
      return output.ok ? 0 : 3;
    }

    if (command === "run") {
      const output = await runProject(configPath, {
        ...(device ? { deviceSerial: device } : {}),
        ...(scenario ? { scenarioId: scenario } : {}),
        ...(adb ? { adbPath: adb } : {}),
        ...(maestro ? { maestroPath: maestro } : {}),
      });
      io.out(
        [
          output.report.readiness + " · " + output.report.outcome,
          "HTML: " + output.artifacts.html,
          "JSON: " + output.artifacts.json,
          "JUnit: " + output.artifacts.junit,
        ].join("\n"),
      );
      return output.exitCode;
    }

    if (command === "matrix") {
      const matrixRunner = dependencies.runFixtureMatrix ?? runFixtureMatrix;
      const output = await matrixRunner({
        ...(device ? { deviceSerial: device } : {}),
        ...(adb ? { adbPath: adb } : {}),
        ...(maestro ? { maestroPath: maestro } : {}),
      });
      io.out(parsed.values.json ? JSON.stringify(output, null, 2) : humanMatrix(output));
      return output.exitCode;
    }

    io.error("Unknown command: " + command);
    io.error(HELP);
    return 2;
  } catch (error) {
    if (error instanceof ConfigError) {
      io.error("Configuration error:\n" + error.issues.map((issue) => "- " + issue).join("\n"));
      return 2;
    }
    if (error instanceof FixtureMatrixValidationError) {
      io.error("Fixture matrix error:\n" + error.issues.map((issue) => "- " + issue).join("\n"));
      return 2;
    }
    if (error instanceof FixtureMatrixEnvironmentError) {
      io.error("Fixture matrix environment error:\n" + error.issues.map((issue) => "- " + issue).join("\n"));
      return 3;
    }
    io.error(error instanceof Error ? error.message : String(error));
    return 4;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
