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
  lintPilotPolicy,
  PilotError,
  runPilot,
  startPilot,
} from "./commands/pilot.js";
import { validateProject } from "./commands/validate.js";
import { FixtureMatrixValidationError } from "./fixtures/matrix.js";
import { createPublicPilotEvidenceBinding } from "./pilot/binding.js";
import {
  createPilotSessionScopeReceipt,
  PilotSessionScopeError,
} from "./pilot/session-scope.js";
import {
  preparePilotSessionScope,
  type PilotSessionScopeDraftResultV1,
} from "./pilot/scope-preparation.js";
import {
  CohortError,
  verifyCohortEvidence,
  type CohortVerificationOutput,
} from "./pilot/cohort.js";
import {
  auditPrivateCohortRegister,
  CohortRegisterError,
  type CohortRegisterAuditOutput,
} from "./pilot/cohort-register.js";
import { verifyPublicPilotEvidence } from "./pilot/public-evidence.js";
import { getCoreRuleCatalog, type CoreRuleCatalog } from "./rules/catalog.js";
import { LAUNCHRIG_VERSION } from "./version.js";

export interface CliIO {
  out(message: string): void;
  error(message: string): void;
}

export interface CliDependencies {
  runFixtureMatrix?: typeof runFixtureMatrix;
  startPilot?: typeof startPilot;
  checkPilot?: typeof checkPilot;
  lintPilotPolicy?: typeof lintPilotPolicy;
  runPilot?: typeof runPilot;
  getPilotStatus?: typeof getPilotStatus;
  exportPilotEvidence?: typeof exportPilotEvidence;
  createPublicPilotEvidenceBinding?: typeof createPublicPilotEvidenceBinding;
  createPilotSessionScopeReceipt?: typeof createPilotSessionScopeReceipt;
  preparePilotSessionScope?: typeof preparePilotSessionScope;
  verifyPublicPilotEvidence?: typeof verifyPublicPilotEvidence;
  verifyCohortEvidence?: typeof verifyCohortEvidence;
  auditPrivateCohortRegister?: typeof auditPrivateCohortRegister;
}

const defaultIO: CliIO = {
  out: (message) => console.log(message),
  error: (message) => console.error(message),
};

const HELP = [
  "LaunchRig " + LAUNCHRIG_VERSION,
  "",
  "Usage:",
  "  launchrig rules [--json]",
  "  launchrig init [--name NAME] [--package APP_ID] [--force]",
  "  launchrig validate [--config launchrig.yml] [--json]",
  "  launchrig doctor [--config launchrig.yml] [--device SERIAL] [--json]",
  "  launchrig run [--config launchrig.yml] [--device SERIAL] [--scenario ID]",
  "  launchrig matrix [--device SERIAL] [--json]  (source checkout only)",
  "  launchrig pilot lint [--config launchrig.yml] [--json]",
  "  launchrig pilot start --pilot ID [--config launchrig.yml] [--force]",
  "  launchrig pilot check --pilot ID --scope FILE [--config launchrig.yml] [--device SERIAL] [--json]",
  "  launchrig pilot run --pilot ID --scope FILE [--config launchrig.yml] [--device SERIAL] [--repeat N]",
  "  launchrig pilot status --pilot ID [--config launchrig.yml] [--json]",
  "  launchrig pilot export --pilot ID [--config launchrig.yml] [--output FILE] [--force] [--json]",
  "  launchrig pilot verify FILE [--json]",
  "  launchrig pilot binding FILE [--json]",
  "  launchrig pilot scope FILE [--json]",
  "  launchrig pilot prepare-scope --bundle DIRECTORY --expires-on YYYY-MM-DD --deletion-method METHOD --output FILE [--config launchrig.yml] [--json]",
  "    METHOD: standard-delete | secure-delete | publisher-managed | other-documented",
  "  launchrig cohort verify FILE... [--json]",
  "  launchrig cohort audit REGISTER [EVIDENCE...] [--json]",
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

function humanRuleCatalog(value: CoreRuleCatalog): string {
  const domains = ["configuration", "runtime", "pilot"] as const;
  const lines = [
    "LaunchRig core rule catalog v" + value.catalogVersion,
    "status: " + value.status,
    "rules: " + value.ruleCount,
  ];
  for (const domain of domains) {
    const rules = value.rules.filter((rule) => rule.domain === domain);
    lines.push("", domain + " (" + rules.length + ")");
    for (const rule of rules) {
      lines.push(rule.ruleId + " " + rule.checkId + ": " + rule.title);
    }
  }
  lines.push(
    "",
    "catalog SHA-256: " + value.catalogSha256,
    "grant milestone complete: no",
  );
  for (const limitation of value.limitations) lines.push("- " + limitation);
  return lines.join("\n");
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

function humanPilotPolicyLint(value: Awaited<ReturnType<typeof lintPilotPolicy>>): string {
  const lines = [
    value.staticPolicyValid
      ? "Pilot policy lint: static policy passed, ready for private scope preparation"
      : "Pilot policy lint: action required",
  ];
  for (const check of value.checks) {
    lines.push((check.status === "pass" ? "PASS " : "FAIL ") + check.summary);
  }
  lines.push(
    "pilot state checked: no",
    "device environment checked: no",
    "external grant gate: not established",
    "grant ready: no",
  );
  for (const limitation of value.limitations) lines.push("- " + limitation);
  if (value.staticPolicyValid) {
    lines.push(
      "Next device-free step: prepare and approve the private scope with launchrig pilot prepare-scope and launchrig pilot scope. Connect the phone only after the approval receipt is unchanged.",
    );
  }
  return lines.join("\n");
}

function humanPilotEvidenceBinding(value: Awaited<ReturnType<typeof createPublicPilotEvidenceBinding>>): string {
  const lines = [
    "Public pilot evidence binding receipt",
    "evidence ID: " + value.binding.evidenceId,
    "file SHA-256: " + value.binding.fileSha256,
    "internal evidence SHA-256: " + value.binding.evidenceSha256,
    "evidence schema: v" + value.binding.schemaVersion,
    "technical status: " + value.technicalStatus,
    "claim status: " + value.claimStatus,
    "external grant gate: " + value.externalGrantGate,
    "grant ready: no",
  ];
  for (const limitation of value.limitations) lines.push("- " + limitation);
  return lines.join("\n");
}

function humanPilotSessionScope(value: Awaited<ReturnType<typeof createPilotSessionScopeReceipt>>): string {
  const lines = [
    "Pilot session scope receipt",
    "scope file SHA-256: " + value.scopeFileSha256,
    "bundle ID: " + value.binding.bundleId,
    "manifest SHA-256: " + value.bundleVerification.manifestSha256,
    "SHA256SUMS SHA-256: " + value.bundleVerification.sha256SumsSha256,
    "package SHA-256: " + value.binding.packageSha256,
    "app build SHA-256: " + value.binding.appBuildSha256,
    "wallet artifact SHA-256: " + value.binding.walletArtifactSha256,
    "flow review SHA-256: " + value.binding.flowReviewSha256,
    "scope SHA-256: " + value.binding.scopeSha256,
    "policy valid: yes",
    "claim status: " + value.claimStatus,
    "publisher identity: not established",
    "consent authenticity: not established",
    "device environment: not established",
    "external grant gate: not established",
    "grant ready: no",
  ];
  for (const limitation of value.limitations) lines.push("- " + limitation);
  return lines.join("\n");
}

function humanPilotSessionScopeDraft(value: PilotSessionScopeDraftResultV1): string {
  const lines = [
    "Private pilot session scope draft created",
    "scope file SHA-256: " + value.scopeFileSha256,
    "bundle ID: " + value.binding.bundleId,
    "package SHA-256: " + value.binding.packageSha256,
    "app build SHA-256: " + value.binding.appBuildSha256,
    "wallet artifact SHA-256: " + value.binding.walletArtifactSha256,
    "flow review SHA-256: " + value.binding.flowReviewSha256,
    "scope SHA-256: " + value.binding.scopeSha256,
    "local bundle integrity: verified",
    "human review required: yes",
    "approval receipt created: no",
    "pilot state checked: no",
    "device environment checked: no",
    "publisher identity: not established",
    "consent authenticity: not established",
    "bundle authenticity: not established",
    "external grant gate: not established",
    "grant ready: no",
  ];
  for (const limitation of value.limitations) lines.push("- " + limitation);
  lines.push("Next: review the private draft, then run launchrig pilot scope FILE.");
  return lines.join("\n");
}

function humanCohortVerification(value: CohortVerificationOutput): string {
  const lines = [
    "Cohort evidence verification: internally consistent",
    "evidence files: " + value.summary.submittedEvidenceFiles,
    "unique evidence IDs: " + value.summary.uniqueEvidenceIds,
    "recomputable evidence v2 files: " + value.summary.recomputableV2Files,
    "scope-enforced evidence v3 files: " + value.summary.scopeEnforcedV3Files,
    "self-recorded technical files qualified: " +
      value.summary.technicallyQualifiedFiles +
      "/" +
      value.summary.requiredTechnicallyQualifiedFiles,
  ];
  for (const entry of value.evidence) {
    const detail =
      entry.technicalStatus === "not-recomputable"
        ? "evidence v1, technical gate not recomputable"
        : "evidence v" + entry.schemaVersion + ", technical gate " + entry.technicalStatus;
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

function humanCohortRegisterAudit(value: CohortRegisterAuditOutput): string {
  const lines = [
    "Private cohort register audit: internally consistent",
    "register content SHA-256: " + value.register.contentSha256,
    "register integrity recorded: " + (value.register.integrityRecorded ? "yes" : "no"),
    "candidate records: " + value.summary.candidateRecords,
    "recorded included candidates: " + value.summary.recordedIncludedCandidates,
    "included candidates with recomputed qualified evidence v2: " +
      value.summary.recordedIncludedWithQualifiedV2 +
      "/" +
      value.summary.requiredPublisherProjects,
    "included candidates with scope-linked qualified evidence v3: " +
      value.summary.recordedIncludedWithScopeQualifiedV3 +
      "/" +
      value.summary.requiredPublisherProjects,
    "distinct recorded publishers for qualified included candidates: " +
      value.summary.distinctRecordedPublishersForQualifiedIncluded,
    "distinct recorded projects for qualified included candidates: " +
      value.summary.distinctRecordedProjectsForQualifiedIncluded,
  ];
  for (const entry of value.entries) {
    lines.push(
      "candidate " +
        entry.index +
        ": " +
        entry.governanceStatus +
        ", " +
        entry.evidenceStatus +
        (entry.blockers.length > 0 ? ", blockers " + entry.blockers.join(", ") : ""),
    );
  }
  for (const defect of value.defects) {
    lines.push(
      "defect " +
        defect.index +
        ": " +
        defect.structuralStatus +
        ", qualified reproduction bindings " +
        defect.qualifiedReproductionBindings +
        (defect.blockers.length > 0 ? ", blockers " + defect.blockers.join(", ") : ""),
    );
  }
  lines.push(
    "recorded governance and technical threshold: " +
      (value.summary.recordedGovernanceAndTechnicalThresholdMet ? "met" : "not met"),
    "publisher identity and authority: not established",
    "publisher consent and independence: not established",
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
  for (const argument of argv) {
    if (!argument.startsWith("-")) continue;
    const separator = argument.indexOf("=");
    const name = argument.startsWith("--")
      ? separator >= 0
        ? argument.slice(0, separator)
        : argument
      : argument.slice(0, 2);
    if (!allowed.has(name)) return name;
  }
  return undefined;
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
        scope: { type: "string" },
        repeat: { type: "string" },
        output: { type: "string" },
        bundle: { type: "string" },
        "expires-on": { type: "string" },
        "deletion-method": { type: "string" },
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
  const scopePath = typeof parsed.values.scope === "string" ? parsed.values.scope : undefined;
  const repeatValue = typeof parsed.values.repeat === "string" ? Number(parsed.values.repeat) : undefined;
  const outputPath = typeof parsed.values.output === "string" ? parsed.values.output : undefined;
  const bundleDirectory = typeof parsed.values.bundle === "string" ? parsed.values.bundle : undefined;
  const expiresOn = typeof parsed.values["expires-on"] === "string" ? parsed.values["expires-on"] : undefined;
  const deletionMethod =
    typeof parsed.values["deletion-method"] === "string" ? parsed.values["deletion-method"] : undefined;

  try {
    if (command === "rules") {
      const rejectedOption = unsupportedOption(
        argv,
        new Set(["--json", "--help", "-h", "--version", "-v"]),
      );
      if (rejectedOption) {
        io.error("rules does not accept " + rejectedOption);
        return 2;
      }
      if (parsed.positionals.length !== 1) {
        io.error("rules does not accept positional arguments");
        return 2;
      }
      const catalog = getCoreRuleCatalog();
      io.out(parsed.values.json ? JSON.stringify(catalog, null, 2) : humanRuleCatalog(catalog));
      return 0;
    }

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
      const rejectedOption = unsupportedOption(
        argv,
        new Set(["--json", "--help", "-h", "--version", "-v"]),
      );
      if (subcommand === "verify") {
        if (rejectedOption) throw new CohortError("cohort verify does not accept " + rejectedOption);
        const evidencePaths = parsed.positionals.slice(2);
        const verifyCohort = dependencies.verifyCohortEvidence ?? verifyCohortEvidence;
        const output = await verifyCohort(evidencePaths);
        io.out(parsed.values.json ? JSON.stringify(output, null, 2) : humanCohortVerification(output));
        return 0;
      }

      if (subcommand === "audit") {
        if (rejectedOption) throw new CohortRegisterError("cohort audit does not accept " + rejectedOption);
        const registerPath = parsed.positionals[2];
        if (!registerPath) throw new CohortRegisterError("cohort audit requires a private register file");
        const evidencePaths = parsed.positionals.slice(3);
        const auditRegister = dependencies.auditPrivateCohortRegister ?? auditPrivateCohortRegister;
        const output = await auditRegister(registerPath, evidencePaths);
        io.out(parsed.values.json ? JSON.stringify(output, null, 2) : humanCohortRegisterAudit(output));
        return 0;
      }
      throw new CohortError("cohort command must be verify or audit");
    }

    if (command === "pilot") {
      const subcommand = parsed.positionals[1];

      if (subcommand === "lint") {
        const rejectedOption = unsupportedOption(
          argv,
          new Set(["--config", "-c", "--json", "--help", "-h", "--version", "-v"]),
        );
        if (rejectedOption) throw new PilotError("pilot lint does not accept " + rejectedOption);
        if (parsed.positionals.length !== 2) {
          throw new PilotError("pilot lint does not accept positional arguments");
        }
        const lint = dependencies.lintPilotPolicy ?? lintPilotPolicy;
        const output = await lint({ configPath });
        io.out(parsed.values.json ? JSON.stringify(output, null, 2) : humanPilotPolicyLint(output));
        return output.exitCode;
      }

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
                output.schemaVersion >= 2
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

      if (subcommand === "binding") {
        const rejectedOption = unsupportedOption(
          argv,
          new Set(["--json", "--help", "-h", "--version", "-v"]),
        );
        if (rejectedOption) {
          throw new PilotError("pilot binding does not accept " + rejectedOption);
        }
        const evidencePath = parsed.positionals[2];
        if (!evidencePath || parsed.positionals.length !== 3) {
          throw new PilotError("pilot binding requires exactly one evidence file");
        }
        const createBinding =
          dependencies.createPublicPilotEvidenceBinding ?? createPublicPilotEvidenceBinding;
        const output = await createBinding(evidencePath);
        io.out(parsed.values.json ? JSON.stringify(output, null, 2) : humanPilotEvidenceBinding(output));
        return 0;
      }

      if (subcommand === "scope") {
        const rejectedOption = unsupportedOption(
          argv,
          new Set(["--json", "--help", "-h", "--version", "-v"]),
        );
        if (rejectedOption) {
          throw new PilotSessionScopeError("pilot scope does not accept " + rejectedOption);
        }
        const scopePath = parsed.positionals[2];
        if (!scopePath || parsed.positionals.length !== 3) {
          throw new PilotSessionScopeError("pilot scope requires exactly one private scope file");
        }
        const createScope =
          dependencies.createPilotSessionScopeReceipt ?? createPilotSessionScopeReceipt;
        const output = await createScope(scopePath);
        io.out(parsed.values.json ? JSON.stringify(output, null, 2) : humanPilotSessionScope(output));
        return 0;
      }

      if (subcommand === "prepare-scope") {
        const rejectedOption = unsupportedOption(
          argv,
          new Set([
            "--config",
            "-c",
            "--bundle",
            "--expires-on",
            "--deletion-method",
            "--output",
            "--json",
            "--help",
            "-h",
            "--version",
            "-v",
          ]),
        );
        if (rejectedOption) {
          throw new PilotSessionScopeError("pilot prepare-scope does not accept " + rejectedOption);
        }
        if (parsed.positionals.length !== 2) {
          throw new PilotSessionScopeError("pilot prepare-scope does not accept positional arguments");
        }
        if (!bundleDirectory || !expiresOn || !deletionMethod || !outputPath) {
          throw new PilotSessionScopeError(
            "pilot prepare-scope requires --bundle DIRECTORY, --expires-on YYYY-MM-DD, --deletion-method METHOD, and --output FILE",
          );
        }
        const prepareScope = dependencies.preparePilotSessionScope ?? preparePilotSessionScope;
        const output = await prepareScope({
          configPath,
          bundleDirectory,
          expiresOn,
          deletionMethod,
          outputPath,
        });
        io.out(parsed.values.json ? JSON.stringify(output, null, 2) : humanPilotSessionScopeDraft(output));
        return 0;
      }

      if (!pilotId) throw new PilotError("pilot commands require --pilot ID");

      if (subcommand === "start") {
        const rejectedOption = unsupportedOption(
          argv,
          new Set(["--pilot", "--config", "-c", "--force", "--json", "--help", "-h", "--version", "-v"]),
        );
        if (rejectedOption) throw new PilotError("pilot start does not accept " + rejectedOption);
        if (parsed.positionals.length !== 2) {
          throw new PilotError("pilot start does not accept positional arguments");
        }
        const start = dependencies.startPilot ?? startPilot;
        const output = await start({ pilotId, configPath, force: parsed.values.force === true });
        const rendered = { ...output, statePath: path.relative(process.cwd(), output.statePath) };
        io.out(
          parsed.values.json
            ? JSON.stringify(rendered, null, 2)
              : [
                "Pilot " + pilotId + " started. State: " + rendered.statePath,
                "Next: create or edit launchrig.yml, run launchrig validate and launchrig pilot lint, then prepare and approve the private scope before connecting a phone.",
              ].join("\n"),
        );
        return 0;
      }

      if (subcommand === "check") {
        const rejectedOption = unsupportedOption(
          argv,
          new Set([
            "--pilot",
            "--scope",
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
        if (!scopePath) throw new PilotError("pilot check requires --scope FILE");
        const check = dependencies.checkPilot ?? checkPilot;
        const output = await check({
          pilotId,
          configPath,
          scopePath,
          ...(device ? { deviceSerial: device } : {}),
          ...(adb ? { adbPath: adb } : {}),
          ...(maestro ? { maestroPath: maestro } : {}),
        });
        const rendered = { ...output, statePath: path.relative(process.cwd(), output.statePath) };
        io.out(parsed.values.json ? JSON.stringify(rendered, null, 2) : humanPilotCheck(output));
        return output.exitCode;
      }

      if (subcommand === "run") {
        const rejectedOption = unsupportedOption(
          argv,
          new Set([
            "--pilot",
            "--scope",
            "--config",
            "-c",
            "--device",
            "-d",
            "--adb",
            "--maestro",
            "--repeat",
            "--json",
            "--help",
            "-h",
            "--version",
            "-v",
          ]),
        );
        if (rejectedOption) throw new PilotError("pilot run does not accept " + rejectedOption);
        if (parsed.positionals.length !== 2) {
          throw new PilotError("pilot run does not accept positional arguments");
        }
        if (!scopePath) throw new PilotError("pilot run requires --scope FILE");
        if (repeatValue !== undefined && !Number.isSafeInteger(repeatValue)) {
          throw new PilotError("--repeat must be an integer from 1 to 10");
        }
        const run = dependencies.runPilot ?? runPilot;
        const output = await run({
          pilotId,
          configPath,
          scopePath,
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
        const rejectedOption = unsupportedOption(
          argv,
          new Set(["--pilot", "--config", "-c", "--json", "--help", "-h", "--version", "-v"]),
        );
        if (rejectedOption) throw new PilotError("pilot status does not accept " + rejectedOption);
        if (parsed.positionals.length !== 2) {
          throw new PilotError("pilot status does not accept positional arguments");
        }
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
        const rejectedOption = unsupportedOption(
          argv,
          new Set([
            "--pilot",
            "--config",
            "-c",
            "--output",
            "--force",
            "--json",
            "--help",
            "-h",
            "--version",
            "-v",
          ]),
        );
        if (rejectedOption) throw new PilotError("pilot export does not accept " + rejectedOption);
        if (parsed.positionals.length !== 2) {
          throw new PilotError("pilot export does not accept positional arguments");
        }
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
                "Self-recorded, unattested pilot evidence v" + output.evidence.schemaVersion + " exported: " + renderedPath,
                "Next: run launchrig pilot verify on that file before sharing it.",
              ].join("\n"),
        );
        return 0;
      }

      throw new PilotError(
        "pilot command must be lint, start, check, run, status, export, verify, binding, scope, or prepare-scope",
      );
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
    if (error instanceof PilotSessionScopeError) {
      io.error("Pilot session scope error: " + error.message);
      return error.exitCode;
    }
    if (error instanceof CohortError) {
      io.error("Cohort error: " + error.message);
      return error.exitCode;
    }
    if (error instanceof CohortRegisterError) {
      io.error("Cohort register error: " + error.message);
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
