#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "./config/schema.js";
import { doctor } from "./commands/doctor.js";
import { initProject } from "./commands/init.js";
import {
  FixtureMatrixEnvironmentError,
  runFixtureMatrix,
  type RunFixtureMatrixOutput,
} from "./commands/matrix.js";
import { runProject } from "./commands/run.js";
import {
  checkPilot,
  exportPilotEvidence,
  getPilotStatus,
  PilotError,
  runPilot,
  startPilot,
} from "./commands/pilot.js";
import { validateProject } from "./commands/validate.js";
import { FixtureMatrixValidationError } from "./fixtures/matrix.js";
import {
  CohortError,
  verifyCohortEvidence,
  type CohortVerificationOutput,
} from "./pilot/cohort.js";
import { verifyPublicPilotEvidence } from "./pilot/public-evidence.js";
import { LAUNCHRIG_VERSION } from "./version.js";

export interface CliIO {
  out(message: string): void;
  error(message: string): void;
}

export interface CliDependencies {
  runFixtureMatrix?: typeof runFixtureMatrix;
  startPilot?: typeof startPilot;
  checkPilot?: typeof checkPilot;
  runPilot?: typeof runPilot;
  getPilotStatus?: typeof getPilotStatus;
  exportPilotEvidence?: typeof exportPilotEvidence;
  verifyPublicPilotEvidence?: typeof verifyPublicPilotEvidence;
  verifyCohortEvidence?: typeof verifyCohortEvidence;
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
  "  launchrig matrix [--device SERIAL] [--json]  (source checkout only)",
  "  launchrig pilot start --pilot ID [--config launchrig.yml] [--force]",
  "  launchrig pilot check --pilot ID [--config launchrig.yml] [--device SERIAL] [--json]",
  "  launchrig pilot run --pilot ID [--config launchrig.yml] [--device SERIAL] [--repeat N]",
  "  launchrig pilot status --pilot ID [--config launchrig.yml] [--json]",
  "  launchrig pilot export --pilot ID [--config launchrig.yml] [--output FILE] [--force] [--json]",
  "  launchrig pilot verify FILE [--json]",
  "  launchrig cohort verify FILE... [--json]",
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
    const label = execution.caseId + " " + execution.variant;
    lines.push(
      label + ": " + execution.output.report.outcome + ", exit " + execution.output.exitCode,
      label + " JSON: " + execution.output.artifacts.json,
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

function humanDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "not available";
  if (milliseconds < 60_000) return (milliseconds / 1000).toFixed(1) + " seconds";
  return (milliseconds / 60_000).toFixed(1) + " minutes";
}

function humanPilotCheck(value: Awaited<ReturnType<typeof checkPilot>>): string {
  const lines = [
    value.readyToRecord ? "Pilot preflight: ready to record" : "Pilot preflight: action required",
  ];
  for (const check of value.checks) {
    const label = check.status === "pass" ? "PASS " : check.status === "skip" ? "SKIP " : "FAIL ";
    lines.push(label + check.summary);
  }
  lines.push(
    "technical pilot gate: " + (value.technicalPilot.qualified ? "met" : "not met"),
    "trailing Android/MWA Ready passes: " +
      value.technicalPilot.trailingMwaPasses +
      "/" +
      value.technicalPilot.requiredTrailingMwaPasses,
    "external grant gate: not established from local pilot state",
    "No pilot attempt was recorded by this check.",
  );
  return lines.join("\n");
}

function humanCohortVerification(value: CohortVerificationOutput): string {
  const lines = [
    "Cohort evidence verification: internally consistent",
    "evidence files: " + value.summary.submittedEvidenceFiles,
    "unique evidence IDs: " + value.summary.uniqueEvidenceIds,
    "recomputable evidence v2 files: " + value.summary.recomputableV2Files,
    "self-recorded technical files qualified: " +
      value.summary.technicallyQualifiedFiles +
      "/" +
      value.summary.requiredTechnicallyQualifiedFiles,
  ];
  for (const entry of value.evidence) {
    const detail =
      entry.technicalStatus === "not-recomputable"
        ? "evidence v1, technical gate not recomputable"
        : "evidence v2, technical gate " + entry.technicalStatus;
    lines.push("evidence " + entry.index + " " + entry.evidenceId + ": " + detail);
  }
  lines.push(
    "self-recorded technical threshold: " +
      (value.summary.selfRecordedTechnicalThresholdMet ? "met" : "not met"),
    "three independent publishers: not established",
    "publisher consent: not established",
    "confirmed defect across two projects: not established",
    "Seeker attestation: not established",
    "public release: not established",
    "external grant gate: not established",
    "grant ready: no",
  );
  for (const limitation of value.limitations) lines.push("- " + limitation);
  return lines.join("\n");
}

function unsupportedOption(argv: string[], allowed: ReadonlySet<string>): string | undefined {
  return argv.find((argument) => {
    if (!argument.startsWith("-")) return false;
    const separator = argument.indexOf("=");
    const name = separator >= 0 ? argument.slice(0, separator) : argument;
    return !allowed.has(name);
  });
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
        pilot: { type: "string" },
        repeat: { type: "string" },
        output: { type: "string" },
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
  const pilotId = typeof parsed.values.pilot === "string" ? parsed.values.pilot : undefined;
  const repeatValue = typeof parsed.values.repeat === "string" ? Number(parsed.values.repeat) : undefined;
  const outputPath = typeof parsed.values.output === "string" ? parsed.values.output : undefined;

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
      const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
      if (
        !dependencies.runFixtureMatrix &&
        (!existsSync(path.join(sourceRoot, ".git")) ||
          !existsSync(path.join(sourceRoot, "fixtures", "launchrig-matrix.v1.json")))
      ) {
        throw new FixtureMatrixEnvironmentError([
          "launchrig matrix is available only from a LaunchRig source checkout with its controlled local fixtures",
        ]);
      }
      const output = await matrixRunner({
        ...(!dependencies.runFixtureMatrix ? { cwd: sourceRoot } : {}),
        ...(device ? { deviceSerial: device } : {}),
        ...(adb ? { adbPath: adb } : {}),
        ...(maestro ? { maestroPath: maestro } : {}),
      });
      io.out(parsed.values.json ? JSON.stringify(output, null, 2) : humanMatrix(output));
      return output.exitCode;
    }

    if (command === "cohort") {
      const subcommand = parsed.positionals[1];
      if (subcommand !== "verify") {
        throw new CohortError("cohort command must be verify");
      }
      const rejectedOption = unsupportedOption(
        argv,
        new Set(["--json", "--help", "-h", "--version", "-v"]),
      );
      if (rejectedOption) throw new CohortError("cohort verify does not accept " + rejectedOption);
      const evidencePaths = parsed.positionals.slice(2);
      const verifyCohort = dependencies.verifyCohortEvidence ?? verifyCohortEvidence;
      const output = await verifyCohort(evidencePaths);
      io.out(parsed.values.json ? JSON.stringify(output, null, 2) : humanCohortVerification(output));
      return 0;
    }

    if (command === "pilot") {
      const subcommand = parsed.positionals[1];

      if (subcommand === "verify") {
        const rejectedOption = unsupportedOption(
          argv,
          new Set(["--json", "--help", "-h", "--version", "-v"]),
        );
        if (rejectedOption) {
          throw new PilotError("pilot verify does not accept " + rejectedOption);
        }
        const evidencePath = parsed.positionals[2];
        if (!evidencePath || parsed.positionals.length !== 3) {
          throw new PilotError("pilot verify requires exactly one evidence file");
        }
        const verifyEvidence = dependencies.verifyPublicPilotEvidence ?? verifyPublicPilotEvidence;
        const output = await verifyEvidence(evidencePath);
        io.out(
          parsed.values.json
            ? JSON.stringify(output, null, 2)
            : [
                "Public pilot evidence: internally consistent",
                "Integrity valid. Evidence remains self-recorded and unattested.",
                "evidence schema: v" + output.schemaVersion,
                "evidence-qualifying runs: " + output.metrics.qualifyingRuns + "/" + output.metrics.runAttempts,
                output.schemaVersion === 2
                  ? "technical pilot gate (recomputed from self-recorded fields): " +
                    (output.reportedTechnicalTargetsMet ? "met" : "not met")
                  : "technical pilot gate: not independently recomputable from evidence v1",
                "external grant gate: not established",
                "grant ready: no",
                ...output.limitations.map((limitation) => "- " + limitation),
              ].join("\n"),
        );
        return 0;
      }

      if (!pilotId) throw new PilotError("pilot commands require --pilot ID");

      if (subcommand === "start") {
        const start = dependencies.startPilot ?? startPilot;
        const output = await start({ pilotId, configPath, force: parsed.values.force === true });
        const rendered = { ...output, statePath: path.relative(process.cwd(), output.statePath) };
        io.out(
          parsed.values.json
            ? JSON.stringify(rendered, null, 2)
            : [
                "Pilot " + pilotId + " started. State: " + rendered.statePath,
                "Next: create or edit launchrig.yml, then run launchrig validate and launchrig doctor.",
              ].join("\n"),
        );
        return 0;
      }

      if (subcommand === "check") {
        const rejectedOption = unsupportedOption(
          argv,
          new Set([
            "--pilot",
            "--config",
            "-c",
            "--device",
            "-d",
            "--adb",
            "--maestro",
            "--json",
            "--help",
            "-h",
            "--version",
            "-v",
          ]),
        );
        if (rejectedOption) throw new PilotError("pilot check does not accept " + rejectedOption);
        if (parsed.positionals.length !== 2) {
          throw new PilotError("pilot check does not accept positional arguments");
        }
        const check = dependencies.checkPilot ?? checkPilot;
        const output = await check({
          pilotId,
          configPath,
          ...(device ? { deviceSerial: device } : {}),
          ...(adb ? { adbPath: adb } : {}),
          ...(maestro ? { maestroPath: maestro } : {}),
        });
        const rendered = { ...output, statePath: path.relative(process.cwd(), output.statePath) };
        io.out(parsed.values.json ? JSON.stringify(rendered, null, 2) : humanPilotCheck(output));
        return output.exitCode;
      }

      if (subcommand === "run") {
        if (repeatValue !== undefined && !Number.isSafeInteger(repeatValue)) {
          throw new PilotError("--repeat must be an integer from 1 to 10");
        }
        const run = dependencies.runPilot ?? runPilot;
        const output = await run({
          pilotId,
          configPath,
          ...(repeatValue !== undefined ? { repeat: repeatValue } : {}),
          runOptions: {
            ...(device ? { deviceSerial: device } : {}),
            ...(adb ? { adbPath: adb } : {}),
            ...(maestro ? { maestroPath: maestro } : {}),
          },
        });
        const rendered = { ...output, statePath: path.relative(process.cwd(), output.statePath) };
        io.out(
          parsed.values.json
            ? JSON.stringify(rendered, null, 2)
            : [
                "Pilot " + pilotId + ": " + output.runs.length + " run(s) recorded",
                "evidence-qualifying runs: " + output.metrics.qualifyingRuns + "/" + output.metrics.runAttempts,
                "technical pilot gate: " + (output.technicalPilot.qualified ? "met" : "not met"),
                "trailing Android/MWA Ready passes: " +
                  output.technicalPilot.trailingMwaPasses +
                  "/" +
                  output.technicalPilot.requiredTrailingMwaPasses,
                "external grant gate: not established from local pilot state",
                "state: " + rendered.statePath,
              ].join("\n"),
        );
        return output.exitCode;
      }

      if (subcommand === "status") {
        const status = dependencies.getPilotStatus ?? getPilotStatus;
        const output = await status({ pilotId, configPath });
        const rendered = { ...output, statePath: path.relative(process.cwd(), output.statePath) };
        io.out(
          parsed.values.json
            ? JSON.stringify(rendered, null, 2)
            : [
                "Pilot " + pilotId + " status",
                "evidence-qualifying runs: " + output.metrics.qualifyingRuns + "/" + output.metrics.runAttempts,
                "pass rate: " + (output.metrics.passRate * 100).toFixed(1) + "%",
                "technical pilot gate: " + (output.technicalPilot.qualified ? "met" : "not met"),
                "trailing Android/MWA Ready passes: " +
                  output.technicalPilot.trailingMwaPasses +
                  "/" +
                  output.technicalPilot.requiredTrailingMwaPasses,
                "MWA setup duration: " + humanDuration(output.technicalPilot.setupDurationMs),
                "median current-fingerprint MWA runtime: " + humanDuration(output.technicalPilot.medianRunDurationMs),
                "external grant gate: not established from local pilot state",
              ].join("\n"),
        );
        return 0;
      }

      if (subcommand === "export") {
        const exportEvidence = dependencies.exportPilotEvidence ?? exportPilotEvidence;
        const output = await exportEvidence({
          pilotId,
          configPath,
          ...(outputPath ? { outputPath } : {}),
          force: parsed.values.force === true,
        });
        const renderedPath = path.relative(process.cwd(), output.outputPath);
        io.out(
          parsed.values.json
            ? JSON.stringify({ outputPath: renderedPath, evidence: output.evidence }, null, 2)
            : [
                "Self-recorded, unattested pilot evidence v2 exported: " + renderedPath,
                "Next: run launchrig pilot verify on that file before sharing it.",
              ].join("\n"),
        );
        return 0;
      }

      throw new PilotError("pilot command must be start, check, run, status, export, or verify");
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
    if (error instanceof PilotError) {
      io.error("Pilot error: " + error.message);
      return error.exitCode;
    }
    if (error instanceof CohortError) {
      io.error("Cohort error: " + error.message);
      return error.exitCode;
    }
    io.error(error instanceof Error ? error.message : String(error));
    return 4;
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  try {
    return realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
