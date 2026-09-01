import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectPayloadEntries,
  copyRegularBundleInput,
  createPublisherManifest,
  parseBundleArguments,
  renderSha256Sums,
  resolveNewOutputDirectory,
  sha256Value,
} from "./pilot-bundle-lib.mjs";
import { verifyPublisherBundle, verifyPublisherBundleAtIdentity } from "./verify-pilot-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const COPY_MAP = [
  ["docs/publisher-bundle-readme.md", "README.md"],
  ["docs/cohort-audit.md", "docs/cohort-audit.md"],
  ["docs/publisher-pilot-quickstart.md", "docs/publisher-pilot-quickstart.md"],
  ["docs/publisher-prospect-review.md", "docs/publisher-prospect-review.md"],
  ["docs/publisher-recruitment.md", "docs/publisher-recruitment.md"],
  ["docs/publisher-send-decision-recording.md", "docs/publisher-send-decision-recording.md"],
  ["docs/publisher-send-decision-preparation.md", "docs/publisher-send-decision-preparation.md"],
  ["docs/supported-environment.md", "docs/supported-environment.md"],
  ["docs/flows/mwa-authorize.md", "docs/flows/mwa-authorize.md"],
  ["docs/flows/mwa-reject.md", "docs/flows/mwa-reject.md"],
  ["docs/flows/mwa-sign-message.md", "docs/flows/mwa-sign-message.md"],
  ["docs/flows/mwa-siws.md", "docs/flows/mwa-siws.md"],
  ["schemas/launchrig-publisher-bundle.schema.json", "schemas/launchrig-publisher-bundle.schema.json"],
  ["templates/defect-evidence.md", "templates/defect-evidence.md"],
  ["templates/pilot-consent.md", "templates/pilot-consent.md"],
  ["templates/pilot-notes.md", "templates/pilot-notes.md"],
  ["templates/publisher-fit-check.md", "templates/publisher-fit-check.md"],
  ["templates/publisher-intake.md", "templates/publisher-intake.md"],
  ["templates/sharing-review.md", "templates/sharing-review.md"],
];

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function removeStagingDirectoryIfUnchanged(directory, expectedIdentity) {
  const current = await lstat(directory, { bigint: true }).catch(() => undefined);
  if (
    !current ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameDirectoryIdentity(current, expectedIdentity)
  ) {
    return false;
  }
  if ((await readdir(directory)).length !== 0) return false;
  await rmdir(directory);
  return true;
}

function helpText() {
  return [
    "Build the LaunchRig publisher release-candidate bundle.",
    "",
    "Usage:",
    "  pnpm run pilot:bundle -- --output /absolute/path/to/new-bundle-directory",
    "",
    "The output directory must not already exist, and its direct parent must be a real directory.",
    "The source worktree must be clean. The command packs LaunchRig, performs a clean offline",
    "consumer install rehearsal, writes a checksum manifest, and verifies the final bundle.",
  ].join("\n");
}

async function run(command, args, options = {}) {
  const acceptedExitCodes = options.acceptedExitCodes ?? [0];
  const timeoutMs = options.timeoutMs ?? 180_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const capture = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
      if (timedOut) {
        reject(new Error(command + " exceeded its execution timeout."));
      } else if (outputLimitExceeded) {
        reject(new Error(command + " exceeded the bounded output limit."));
      } else if (code !== null && acceptedExitCodes.includes(code)) {
        resolve(result);
      } else {
        reject(new Error(result.stderr || result.stdout || command + " exited with code " + code));
      }
    });
  });
}

function rehearsalDigest(label) {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function rehearsalUuid(index) {
  const value = index.toString(16);
  return value.padStart(8, "0") + "-0000-4000-a000-" + value.padStart(12, "0");
}

function rehearsalRef(kind, index) {
  return "urn:launchrig:" + kind + ":" + rehearsalUuid(index);
}

function qualifiedRehearsalEvidence(index, launchRigVersion, schemaVersion, scopeSha256) {
  const durationMs = 5 * 60_000;
  const setupDurationMs = 10 * 60_000;
  const fingerprint = rehearsalDigest("rehearsal-fingerprint-" + index);
  const legacyRuns = [0, 1, 2].map((runIndex) => ({
    runId: "run-" + String(runIndex + 1).padStart(3, "0"),
    outcome: "passed",
    readiness: "Android/MWA Ready",
    durationMs,
    elapsedSinceStartMs: setupDurationMs + runIndex * 6 * 60_000,
    executionFingerprintSha256: fingerprint,
    launchRigVersion,
    physicalDevice: true,
    requiredChecksPassed: true,
    qualifying: true,
  }));
  const core = {
    schemaVersion,
    kind: "launchrig-pilot-evidence",
    evidenceId: rehearsalUuid(index),
    claimStatus: "self-recorded-unattested",
    metrics: {
      runAttempts: 3,
      qualifyingRuns: 3,
      passRate: 1,
      consecutivePasses: 3,
      medianRunDurationMs: durationMs,
      setupDurationMs,
      executionFingerprintSha256: fingerprint,
      setupTargetMet: true,
      runtimeTargetMet: true,
      repeatabilityTargetMet: true,
    },
    technicalPilot: {
      profile: "external-mwa-pilot-v1",
      qualified: true,
      latestReadiness: "Android/MWA Ready",
      trailingMwaPasses: 3,
      requiredTrailingMwaPasses: 3,
      setupDurationMs,
      medianRunDurationMs: durationMs,
      setupTargetMet: true,
      runtimeTargetMet: true,
      repeatabilityTargetMet: true,
    },
    runs:
      schemaVersion === 3
        ? legacyRuns.map((entry) => ({
            ...entry,
            sessionScopeSha256: scopeSha256,
            scopeInputsMatched: true,
          }))
        : legacyRuns,
    claims: {
      externalPublisher: "not-established",
      seekerHardware: "not-established",
      productionWallet: "not-established",
      seedVault: "not-established",
      confirmedDefect: "not-established",
    },
    ...(schemaVersion === 3
      ? {
          sessionScope: {
            profile: "external-mwa-pilot-scope-v1",
            scopeSha256,
            claimStatus: "operator-prepared-unattested",
          },
        }
      : {}),
  };
  return { ...core, evidenceSha256: sha256Value(core) };
}

function rehearsalCandidate(index, evidenceBinding, scopeSha256) {
  return {
    candidateRef: rehearsalRef("candidate", 100 + index),
    publisherRef: rehearsalRef("publisher", 200 + index),
    projectRef: rehearsalRef("project", 300 + index),
    lineageRef: rehearsalRef("lineage", 400 + index),
    pilotRef: rehearsalRef("pilot", 500 + index),
    recruitment: {
      status: "interest-recorded",
      recordSha256: rehearsalDigest("recruitment-" + index),
      statusOn: "2026-08-01",
    },
    intakeReview: {
      status: "operator-recorded-sufficient",
      recordSha256: rehearsalDigest("intake-" + index),
      reviewedOn: "2026-08-02",
      reviewerRef: rehearsalRef("reviewer", 600 + index),
    },
    independenceReview: {
      status: "operator-recorded-eligible",
      recordSha256: rehearsalDigest("independence-" + index),
      reviewedOn: "2026-08-03",
      reviewerRef: rehearsalRef("reviewer", 700 + index),
      relationshipCodes: ["none-declared"],
    },
    consent: {
      status: "operator-recorded-active",
      recordSha256: rehearsalDigest("consent-" + index),
      scopeSha256,
      effectiveOn: "2026-08-04",
      expiresOn: "2099-12-31",
      withdrawalRecordSha256: null,
      withdrawnOn: null,
    },
    session: {
      status: "completed",
      statusOn: "2026-08-10",
      binding: {
        bundleId: "sha256:" + rehearsalDigest("bundle-" + index),
        packageSha256: rehearsalDigest("package-" + index),
        appBuildSha256: rehearsalDigest("app-build-" + index),
        walletArtifactSha256: rehearsalDigest("wallet-" + index),
        flowReviewSha256: rehearsalDigest("flow-review-" + index),
        scopeSha256,
      },
    },
    evidence: {
      sharingStatus: "operator-recorded-approved",
      binding: evidenceBinding,
      decisionRecordSha256: rehearsalDigest("sharing-" + index),
      decidedOn: "2026-08-11",
      withdrawalRecordSha256: null,
      withdrawnOn: null,
    },
    closeout: {
      status: "operator-recorded-complete",
      recordSha256: rehearsalDigest("closeout-" + index),
      completedOn: "2026-08-12",
    },
    countDecision: {
      status: "operator-recorded-include",
      recordSha256: rehearsalDigest("count-" + index),
      reviewedOn: "2026-08-13",
      reviewerRef: rehearsalRef("reviewer", 800 + index),
      reasonCodes: ["meets-recorded-policy"],
    },
  };
}

function sealedRehearsalRegister(candidates, index) {
  const core = {
    schemaVersion: 1,
    kind: "launchrig-private-cohort-register",
    profile: "phase-2c-publisher-governance-v1",
    privacyProfile: "opaque-refs-digests-dates-v1",
    registerRef: rehearsalRef("register", index),
    revision: 1,
    asOfDate: "2026-08-28",
    operatorRef: rehearsalRef("operator", index),
    candidates,
    defects: [],
  };
  return { ...core, integritySha256: sha256Value(core) };
}

function rehearsalExternalGateIsUnestablished(gate) {
  return (
    gate &&
    Object.keys(gate).length === 8 &&
    Object.values(gate).every((value) => value === "not-established")
  );
}

async function writePrivateRehearsalJson(target, value) {
  await writeFile(target, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await chmod(target, 0o600);
}

async function rehearseInstalledScopeLinkedGovernance(executable, installDirectory, launchRigVersion, environment) {
  const evidenceRecords = [];
  for (const index of [1, 2, 3]) {
    const scopeSha256 = rehearsalDigest("scope-" + index);
    const evidence = qualifiedRehearsalEvidence(index, launchRigVersion, 3, scopeSha256);
    const evidencePath = path.join(installDirectory, "scope-linked-evidence-" + index + ".json");
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await chmod(evidencePath, 0o600);
    const verified = JSON.parse(
      (await run(executable, ["pilot", "verify", evidencePath, "--json"], {
        cwd: installDirectory,
        env: environment,
      })).stdout,
    );
    if (
      verified.schemaVersion !== 3 ||
      verified.sessionScopeSha256 !== scopeSha256 ||
      verified.reportedTechnicalTargetsMet !== true ||
      verified.claimStatus !== "self-recorded-unattested" ||
      verified.grantReady !== false
    ) {
      throw new Error("Clean consumer evidence-v3 verification did not preserve the scope-linked contract.");
    }
    const receipt = JSON.parse(
      (await run(executable, ["pilot", "binding", evidencePath, "--json"], {
        cwd: installDirectory,
        env: environment,
      })).stdout,
    );
    if (
      receipt.binding?.schemaVersion !== 3 ||
      receipt.binding?.evidenceId !== evidence.evidenceId ||
      receipt.binding?.evidenceSha256 !== evidence.evidenceSha256 ||
      receipt.technicalStatus !== "qualified-self-recorded" ||
      receipt.externalGrantGate !== "not-established" ||
      receipt.grantReady !== false ||
      JSON.stringify(receipt).includes(evidencePath)
    ) {
      throw new Error("Clean consumer evidence-v3 binding did not preserve the claim-limited contract.");
    }
    evidenceRecords.push({ path: evidencePath, binding: receipt.binding, scopeSha256 });
  }

  const positiveRegisterPath = path.join(installDirectory, "scope-linked-private-register.json");
  await writePrivateRehearsalJson(
    positiveRegisterPath,
    sealedRehearsalRegister(
      evidenceRecords.map((entry, index) => rehearsalCandidate(index + 1, entry.binding, entry.scopeSha256)),
      1,
    ),
  );
  const positiveAudit = JSON.parse(
    (await run(
      executable,
      ["cohort", "audit", positiveRegisterPath, ...evidenceRecords.map((entry) => entry.path), "--json"],
      { cwd: installDirectory, env: environment },
    )).stdout,
  );
  if (
    positiveAudit.summary?.matchedEvidenceBindings !== 3 ||
    positiveAudit.summary?.recomputedQualifiedV3Bindings !== 3 ||
    positiveAudit.summary?.recordedIncludedWithScopeQualifiedV3 !== 3 ||
    positiveAudit.summary?.recordedGovernanceAndTechnicalThresholdMet !== true ||
    !positiveAudit.entries?.every((entry) => entry.evidenceStatus === "matched-v3-scope-qualified") ||
    !rehearsalExternalGateIsUnestablished(positiveAudit.externalGrantGate) ||
    positiveAudit.grantReady !== false ||
    JSON.stringify(positiveAudit).includes("urn:launchrig:") ||
    JSON.stringify(positiveAudit).includes(positiveRegisterPath)
  ) {
    throw new Error("Clean consumer private audit did not preserve the matched evidence-v3 contract.");
  }

  const mismatchRegisterPath = path.join(installDirectory, "scope-mismatch-private-register.json");
  await writePrivateRehearsalJson(
    mismatchRegisterPath,
    sealedRehearsalRegister(
      [rehearsalCandidate(11, evidenceRecords[0].binding, rehearsalDigest("mismatched-scope"))],
      2,
    ),
  );
  const mismatchAudit = JSON.parse(
    (await run(executable, ["cohort", "audit", mismatchRegisterPath, evidenceRecords[0].path, "--json"], {
      cwd: installDirectory,
      env: environment,
    })).stdout,
  );
  if (
    mismatchAudit.entries?.[0]?.evidenceStatus !== "matched-v3-scope-mismatch" ||
    !mismatchAudit.entries?.[0]?.blockers?.includes("evidence-scope-mismatch") ||
    mismatchAudit.summary?.recordedGovernanceAndTechnicalThresholdMet !== false ||
    mismatchAudit.grantReady !== false
  ) {
    throw new Error("Clean consumer private audit did not block an evidence-v3 scope mismatch.");
  }

  const v2ScopeSha256 = rehearsalDigest("historical-v2-scope");
  const v2Evidence = qualifiedRehearsalEvidence(20, launchRigVersion, 2, v2ScopeSha256);
  const v2Path = path.join(installDirectory, "historical-evidence-v2.json");
  await writeFile(v2Path, JSON.stringify(v2Evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await chmod(v2Path, 0o600);
  const v2Receipt = JSON.parse(
    (await run(executable, ["pilot", "binding", v2Path, "--json"], {
      cwd: installDirectory,
      env: environment,
    })).stdout,
  );
  if (
    v2Receipt.binding?.schemaVersion !== 2 ||
    v2Receipt.technicalStatus !== "qualified-self-recorded" ||
    v2Receipt.grantReady !== false
  ) {
    throw new Error("Clean consumer historical evidence-v2 binding compatibility failed.");
  }
  const v2RegisterPath = path.join(installDirectory, "historical-v2-private-register.json");
  await writePrivateRehearsalJson(
    v2RegisterPath,
    sealedRehearsalRegister([rehearsalCandidate(20, v2Receipt.binding, v2ScopeSha256)], 3),
  );
  const v2Audit = JSON.parse(
    (await run(executable, ["cohort", "audit", v2RegisterPath, v2Path, "--json"], {
      cwd: installDirectory,
      env: environment,
    })).stdout,
  );
  if (
    v2Audit.entries?.[0]?.evidenceStatus !== "matched-v2-qualified" ||
    !v2Audit.entries?.[0]?.blockers?.includes("evidence-scope-unavailable") ||
    v2Audit.summary?.recordedIncludedWithScopeQualifiedV3 !== 0 ||
    v2Audit.summary?.recordedGovernanceAndTechnicalThresholdMet !== false ||
    v2Audit.grantReady !== false
  ) {
    throw new Error("Clean consumer private audit did not keep evidence v2 outside scope-linked governance.");
  }
}

async function assertCleanSource() {
  const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.stdout) throw new Error("Refusing to build a publisher bundle from a dirty Git worktree.");
  const commit = (await run("git", ["rev-parse", "HEAD"])).stdout;
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Could not resolve a full source commit.");
  return commit;
}

async function copyBundleMaterials(stagingDirectory) {
  for (const [source, destination] of COPY_MAP) {
    await copyRegularBundleInput(path.join(root, ...source.split("/")), path.join(stagingDirectory, ...destination.split("/")));
  }
}

async function assertInstalledFile(installDirectory, relativePath) {
  const target = path.join(installDirectory, "node_modules", "launchrig", ...relativePath.split("/"));
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Clean consumer install is missing " + relativePath + ".");
  }
}

async function rehearseCleanConsumer(archivePath, launchRigVersion, bundleDirectory) {
  const temporaryDirectory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "launchrig-publisher-rehearsal-")),
  );
  const installDirectory = path.join(temporaryDirectory, "consumer");
  try {
    const storePath = path.join(temporaryDirectory, "empty-store");
    await mkdir(installDirectory, { recursive: true, mode: 0o700 });
    await mkdir(storePath, { recursive: true, mode: 0o700 });
    const rehearsalEnvironment = { ...process.env };
    for (const key of [
      "ANDROID_SERIAL",
      "LAUNCHRIG_ADB_PATH",
      "LAUNCHRIG_MAESTRO_PATH",
      "NODE_OPTIONS",
      "NODE_PATH",
    ]) {
      delete rehearsalEnvironment[key];
    }
    await run(pnpm, ["add", "--dir", installDirectory, "--offline", "--store-dir", storePath, archivePath], {
      env: rehearsalEnvironment,
    });

    const installedPackagePath = path.join(installDirectory, "node_modules", "launchrig", "package.json");
    const installedPackage = JSON.parse(await readFile(installedPackagePath, "utf8"));
    if (installedPackage.name !== "launchrig" || installedPackage.version !== launchRigVersion) {
      throw new Error("Clean consumer install does not match the packed LaunchRig version.");
    }
    if (installedPackage.private !== true) throw new Error("Packed LaunchRig package must remain private.");
    for (const relativePath of [
      "dist/src/cli.js",
      "dist/src/config/diagnostics.js",
      "dist/src/pilot/binding.js",
      "dist/src/pilot/cohort-preparation.js",
      "dist/src/pilot/prospect-review.js",
      "dist/src/pilot/send-decision-recording.js",
      "dist/src/pilot/send-decision-preparation.js",
      "dist/src/pilot/session-scope.js",
      "dist/src/pilot/scope-preparation.js",
      "docs/cohort-audit.md",
      "docs/cohort-verification.md",
      "docs/config-v1-compatibility.md",
      "docs/github-action.md",
      "docs/phase-3-foundation.md",
      "docs/publisher-pilot-quickstart.md",
      "docs/publisher-prospect-review.md",
      "docs/publisher-recruitment.md",
      "docs/publisher-send-decision-recording.md",
      "docs/publisher-send-decision-preparation.md",
      "docs/supported-environment.md",
      "docs/flows/mwa-authorize.md",
      "docs/flows/mwa-reject.md",
      "docs/flows/mwa-sign-message.md",
      "docs/flows/mwa-siws.md",
      "schemas/launchrig-publisher-bundle.schema.json",
      "schemas/launchrig-cohort-verification.schema.json",
      "schemas/launchrig-core-rule-catalog.schema.json",
      "schemas/fixtures/launchrig-config-v1.conformance.json",
      "schemas/launchrig-private-cohort-audit.schema.json",
      "schemas/launchrig-private-cohort-register.schema.json",
      "schemas/launchrig-private-cohort-register-draft-result.schema.json",
      "schemas/launchrig-private-prospect-review-result.schema.json",
      "schemas/launchrig-private-prospect-review.schema.json",
      "schemas/launchrig-private-human-send-decision-result.schema.json",
      "schemas/launchrig-private-human-send-decision.schema.json",
      "schemas/launchrig-private-send-decision-request-result.schema.json",
      "schemas/launchrig-private-send-decision-request.schema.json",
      "schemas/launchrig-pilot-evidence-binding-receipt.schema.json",
      "schemas/launchrig-pilot-session-scope-receipt.schema.json",
      "schemas/launchrig-pilot-session-scope-draft-result.schema.json",
      "schemas/launchrig-pilot-session-scope.schema.json",
      "scripts/runtime-contract.mjs",
      "scripts/verify-pilot-bundle.mjs",
      "templates/pilot-consent.md",
      "templates/pilot-notes.md",
      "templates/publisher-fit-check.md",
      "templates/publisher-intake.md",
      "templates/sharing-review.md",
      "action.yml",
      "action/run-validation.mjs",
      "examples/github-actions/launchrig-validation.yml",
    ]) {
      await assertInstalledFile(installDirectory, relativePath);
    }

    const operationalRecords = [
      {
        path: "templates/pilot-consent.md",
        required: [
          "scope-linked public evidence v3",
          "mandatory `--scope FILE` options",
          "cannot satisfy the private scope-linked governance threshold",
        ],
      },
      {
        path: "templates/pilot-notes.md",
        required: [
          "scope-linked evidence v3",
          "stable scope-digest linkability",
          "cannot satisfy private scope-linked governance",
        ],
      },
      {
        path: "templates/publisher-fit-check.md",
        required: [
          "positive fit review is not consent",
          "`interest-recorded`",
          "No project or device action is authorized",
        ],
      },
      {
        path: "templates/publisher-intake.md",
        required: [
          "mandatory `--scope FILE` options",
          "scope-linked evidence v3",
          "cannot satisfy private scope-linked governance",
        ],
      },
      {
        path: "templates/sharing-review.md",
        required: [
          "scope-linked evidence v3 JSON",
          "stable scope-digest linkability",
          "cannot satisfy private scope-linked governance",
        ],
      },
    ];
    for (const record of operationalRecords) {
      const recordSource = await readFile(
        path.join(installDirectory, "node_modules", "launchrig", ...record.path.split("/")),
        "utf8",
      );
      for (const phrase of record.required) {
        if (!recordSource.includes(phrase)) {
          throw new Error("Clean consumer operational record is missing its evidence-v3 contract: " + record.path + ".");
        }
      }
    }

    const executable = path.join(
      installDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "launchrig.cmd" : "launchrig",
    );
    const version = await run(executable, ["--version"], { cwd: installDirectory, env: rehearsalEnvironment });
    if (version.stdout !== launchRigVersion) throw new Error("Installed LaunchRig binary reported the wrong version.");
    const help = await run(executable, ["--help"], { cwd: installDirectory, env: rehearsalEnvironment });
    for (const command of [
      "launchrig rules [--json]",
      "launchrig pilot lint",
      "launchrig pilot check --pilot ID --scope FILE",
      "launchrig pilot run --pilot ID --scope FILE",
      "launchrig pilot verify FILE",
      "launchrig pilot binding FILE",
      "launchrig pilot scope FILE",
      "launchrig pilot prepare-scope",
      "launchrig cohort verify FILE...",
      "launchrig cohort audit REGISTER [EVIDENCE...]",
      "launchrig cohort prepare-register --output FILE",
      "launchrig cohort record-prospect-review --prospect FILE",
      "launchrig cohort prepare-send-decision --review FILE --expected-review-sha256 HASH --prospect FILE --expected-prospect-sha256 HASH --draft FILE --expected-draft-sha256 HASH [--related-review FILE --expected-related-review-sha256 HASH ...] --operator-ref REF --prepared-on YYYY-MM-DD --confirm-related-review-set-complete --output FILE [--json]",
      "launchrig cohort record-send-decision --request FILE --expected-request-sha256 HASH --review FILE --expected-review-sha256 HASH --prospect FILE --expected-prospect-sha256 HASH --draft FILE --expected-draft-sha256 HASH --authorizer-ref REF --decided-on YYYY-MM-DD --decision DECISION --reason-code CODE --source-recheck STATUS --route-recheck STATUS --relationship-disclosure-recheck STATUS --compensation-disclosure-recheck STATUS --safety-recheck STATUS [--authorization-expires-on YYYY-MM-DD] --confirm-human-send-decision --output FILE [--json]",
    ]) {
      if (!help.stdout.includes(command)) throw new Error("Installed LaunchRig help is missing " + command + ".");
    }
    const catalog = JSON.parse(
      (await run(executable, ["rules", "--json"], { cwd: installDirectory, env: rehearsalEnvironment })).stdout,
    );
    if (
      catalog.kind !== "launchrig-core-rule-catalog" ||
      catalog.status !== "pre-award-foundation" ||
      catalog.ruleCount !== 25 ||
      catalog.rules?.length !== 25 ||
      catalog.grantMilestoneComplete !== false
    ) {
      throw new Error("Installed LaunchRig rule catalog does not preserve its pre-award contract.");
    }

    const privateRegisterPath = path.join(temporaryDirectory, "private-recruitment-register.json");
    const registerPreparation = JSON.parse(
      (
        await run(
          executable,
          ["cohort", "prepare-register", "--output", privateRegisterPath, "--json"],
          { cwd: installDirectory, env: rehearsalEnvironment },
        )
      ).stdout,
    );
    const privateRegisterBytes = await readFile(privateRegisterPath);
    const privateRegister = JSON.parse(privateRegisterBytes.toString("utf8"));
    const privateRegisterMetadata = await lstat(privateRegisterPath);
    if (
      registerPreparation.kind !== "launchrig-private-cohort-register-draft-result" ||
      registerPreparation.profile !== "phase-2i-recruitment-register-v1" ||
      registerPreparation.claimStatus !== "operator-prepared-unattested" ||
      registerPreparation.candidateRecords !== 0 ||
      registerPreparation.interestRecorded !== 0 ||
      registerPreparation.projectModificationAuthorized !== false ||
      registerPreparation.phoneAccessAuthorized !== false ||
      registerPreparation.deviceEnvironmentChecked !== false ||
      registerPreparation.candidatePool !== "not-established" ||
      registerPreparation.externalGrantGate !== "not-established" ||
      registerPreparation.grantReady !== false ||
      privateRegister.candidates?.length !== 0 ||
      privateRegister.defects?.length !== 0 ||
      privateRegister.integritySha256 !== null ||
      !privateRegisterMetadata.isFile() ||
      privateRegisterMetadata.nlink !== 1 ||
      (process.platform !== "win32" && (privateRegisterMetadata.mode & 0o777) !== 0o600) ||
      JSON.stringify(registerPreparation).includes(privateRegisterPath) ||
      JSON.stringify(registerPreparation).includes("urn:launchrig:") ||
      JSON.stringify(registerPreparation).includes("Android Device Ready") ||
      JSON.stringify(registerPreparation).includes("Android/MWA Ready")
    ) {
      throw new Error("Clean consumer register preparation did not preserve its private claim-limited contract.");
    }
    const preparedRegisterAudit = JSON.parse(
      (
        await run(executable, ["cohort", "audit", privateRegisterPath, "--json"], {
          cwd: installDirectory,
          env: rehearsalEnvironment,
        })
      ).stdout,
    );
    if (
      preparedRegisterAudit.summary?.candidateRecords !== 0 ||
      preparedRegisterAudit.summary?.interestRecorded !== 0 ||
      preparedRegisterAudit.summary?.recordedGovernanceAndTechnicalThresholdMet !== false ||
      preparedRegisterAudit.externalGrantGate?.status !== "not-established" ||
      preparedRegisterAudit.grantReady !== false
    ) {
      throw new Error("Clean consumer prepared register audit elevated an external claim.");
    }

    const prospectReviewInputPath = path.join(temporaryDirectory, "unreviewed-prospect-input.md");
    const draftReviewInputPath = path.join(temporaryDirectory, "unreviewed-draft-input.md");
    const privateProspectReviewPath = path.join(temporaryDirectory, "private-prospect-review.json");
    const prospectReviewInputBytes = Buffer.from("# Synthetic unreviewed prospect\n\nSource review incomplete.\n", "utf8");
    const draftReviewInputBytes = Buffer.from("# Synthetic do-not-send draft\n\nNo message is authorized.\n", "utf8");
    await writeFile(prospectReviewInputPath, prospectReviewInputBytes, { flag: "wx", mode: 0o600 });
    await writeFile(draftReviewInputPath, draftReviewInputBytes, { flag: "wx", mode: 0o600 });
    await chmod(prospectReviewInputPath, 0o600);
    await chmod(draftReviewInputPath, 0o600);
    const prospectReviewInputSha256 = createHash("sha256").update(prospectReviewInputBytes).digest("hex");
    const draftReviewInputSha256 = createHash("sha256").update(draftReviewInputBytes).digest("hex");
    const reviewFindings = {
      citedSource: "incomplete",
      unobservedDetails: "preserved-as-unknown",
      contactRoute: "appropriate",
      relationshipDisclosure: "complete-or-not-applicable",
      compensationDisclosure: "complete-or-not-applicable",
      messageScope: "fit-check-only",
      installationOrAccessRequest: "absent",
      financialRisk: "excluded",
      biometricRisk: "excluded",
      credentialRisk: "excluded",
      deviceControlRisk: "excluded",
      locationRisk: "excluded",
      productionAccountRisk: "excluded",
      mainnetRisk: "excluded",
      valuableFundsRisk: "excluded",
    };
    const reviewFindingArguments = Object.entries(reviewFindings).flatMap(([key, value]) => [
      "--finding",
      key + "=" + value,
    ]);
    const reviewRefusal = await run(
      executable,
      [
        "cohort",
        "record-prospect-review",
        "--prospect",
        prospectReviewInputPath,
        "--draft",
        draftReviewInputPath,
        "--expected-prospect-sha256",
        prospectReviewInputSha256,
        "--expected-draft-sha256",
        draftReviewInputSha256,
        "--reviewer-ref",
        "urn:launchrig:reviewer:000003b6-0000-4000-a000-0000000003b6",
        "--reviewed-on",
        new Date().toISOString().slice(0, 10),
        "--prospect-label",
        "operator-reviewed-defer",
        "--draft-label",
        "operator-reviewed-do-not-send",
        "--reason-code",
        "source-review-incomplete",
        ...reviewFindingArguments,
        "--output",
        privateProspectReviewPath,
        "--json",
      ],
      { cwd: installDirectory, env: rehearsalEnvironment, acceptedExitCodes: [2] },
    );
    const reviewRefusalOutput = reviewRefusal.stdout + "\n" + reviewRefusal.stderr;
    if (
      !reviewRefusalOutput.includes("Explicit human review confirmation is required") ||
      await lstat(privateProspectReviewPath).then(
        () => true,
        () => false,
      ) ||
      reviewRefusalOutput.includes("Android Device Ready") ||
      reviewRefusalOutput.includes("Android/MWA Ready")
    ) {
      throw new Error("Clean consumer prospect review did not refuse missing human confirmation safely.");
    }

    const sendDecisionOutputPath = path.join(temporaryDirectory, "private-send-decision-request.json");
    const sendDecisionRefusal = await run(
      executable,
      [
        "cohort",
        "prepare-send-decision",
        "--review",
        path.join(temporaryDirectory, "unreadable-selected-review.json"),
        "--expected-review-sha256",
        "a".repeat(64),
        "--prospect",
        path.join(temporaryDirectory, "unreadable-prospect-input.md"),
        "--expected-prospect-sha256",
        "b".repeat(64),
        "--draft",
        path.join(temporaryDirectory, "unreadable-draft-input.md"),
        "--expected-draft-sha256",
        "c".repeat(64),
        "--related-review",
        path.join(temporaryDirectory, "unreadable-related-review.json"),
        "--expected-related-review-sha256",
        "d".repeat(64),
        "--operator-ref",
        "urn:launchrig:reviewer:000003b7-0000-4000-a000-0000000003b7",
        "--prepared-on",
        new Date().toISOString().slice(0, 10),
        "--output",
        sendDecisionOutputPath,
        "--json",
      ],
      { cwd: installDirectory, env: rehearsalEnvironment, acceptedExitCodes: [2] },
    );
    const sendDecisionRefusalOutput = sendDecisionRefusal.stdout + "\n" + sendDecisionRefusal.stderr;
    if (
      !sendDecisionRefusalOutput.includes("Explicit related review set confirmation is required") ||
      await lstat(sendDecisionOutputPath).then(
        () => true,
        () => false,
      ) ||
      sendDecisionRefusalOutput.includes("Android Device Ready") ||
      sendDecisionRefusalOutput.includes("Android/MWA Ready")
    ) {
      throw new Error("Clean consumer send decision preparation did not refuse before reading private inputs.");
    }

    const humanSendDecisionOutputPath = path.join(
      temporaryDirectory,
      "private-human-send-decision.json",
    );
    const humanSendDecisionRefusal = await run(
      executable,
      [
        "cohort",
        "record-send-decision",
        "--request",
        path.join(temporaryDirectory, "unreadable-send-decision-request.json"),
        "--expected-request-sha256",
        "e".repeat(64),
        "--review",
        path.join(temporaryDirectory, "unreadable-send-decision-review.json"),
        "--expected-review-sha256",
        "f".repeat(64),
        "--prospect",
        path.join(temporaryDirectory, "unreadable-send-decision-prospect.md"),
        "--expected-prospect-sha256",
        "a".repeat(64),
        "--draft",
        path.join(temporaryDirectory, "unreadable-send-decision-draft.md"),
        "--expected-draft-sha256",
        "b".repeat(64),
        "--authorizer-ref",
        "urn:launchrig:reviewer:000003b8-0000-4000-a000-0000000003b8",
        "--decided-on",
        new Date().toISOString().slice(0, 10),
        "--decision",
        "authorize-exact-reviewed-draft",
        "--reason-code",
        "exact-fit-check-send-authorized",
        "--source-recheck",
        "reopened-and-fact-confirmed",
        "--route-recheck",
        "appropriate",
        "--relationship-disclosure-recheck",
        "complete-or-not-applicable",
        "--compensation-disclosure-recheck",
        "complete-or-not-applicable",
        "--safety-recheck",
        "fit-check-only-boundaries-confirmed",
        "--authorization-expires-on",
        new Date().toISOString().slice(0, 10),
        "--output",
        humanSendDecisionOutputPath,
        "--json",
      ],
      { cwd: installDirectory, env: rehearsalEnvironment, acceptedExitCodes: [2] },
    );
    const humanSendDecisionRefusalOutput =
      humanSendDecisionRefusal.stdout + "\n" + humanSendDecisionRefusal.stderr;
    if (
      !humanSendDecisionRefusalOutput.includes(
        "Explicit human send decision confirmation is required",
      ) ||
      await lstat(humanSendDecisionOutputPath).then(
        () => true,
        () => false,
      ) ||
      humanSendDecisionRefusalOutput.includes("Android Device Ready") ||
      humanSendDecisionRefusalOutput.includes("Android/MWA Ready")
    ) {
      throw new Error("Clean consumer human send decision did not refuse before reading private inputs.");
    }

    await run(executable, ["pilot", "start", "--pilot", "bundle-rehearsal", "--config", "launchrig.yml"], {
      cwd: installDirectory,
      env: rehearsalEnvironment,
    });
    await run(executable, ["init", "--name", "Bundle Rehearsal App", "--package", "com.example.bundlerehearsal"], {
      cwd: installDirectory,
      env: rehearsalEnvironment,
    });
    const validation = await run(executable, ["validate", "--config", "launchrig.yml"], {
      cwd: installDirectory,
      env: rehearsalEnvironment,
    });
    if (!validation.stdout.includes("Configuration valid")) {
      throw new Error("Clean consumer starter configuration did not validate.");
    }
    const structuredValidation = JSON.parse(
      (
        await run(executable, ["validate", "--config", "launchrig.yml", "--json"], {
          cwd: installDirectory,
          env: rehearsalEnvironment,
        })
      ).stdout,
    );
    const expectedRuleIds = ["LR001", "LR002", "LR003", "LR004", "LR005"];
    if (
      structuredValidation.schemaVersion !== 1 ||
      structuredValidation.kind !== "launchrig-config-validation-result" ||
      structuredValidation.profile !== "config-rules-v1" ||
      structuredValidation.status !== "pre-award-foundation" ||
      structuredValidation.valid !== true ||
      structuredValidation.grantMilestoneComplete !== false ||
      structuredValidation.diagnostics?.length !== 0 ||
      JSON.stringify(structuredValidation.ruleResults?.map((entry) => entry.ruleId)) !==
        JSON.stringify(expectedRuleIds) ||
      structuredValidation.ruleResults?.some(
        (entry) => entry.status !== "passed" || entry.diagnosticCount !== 0,
      )
    ) {
      throw new Error("Clean consumer structured configuration diagnostics did not preserve the contract.");
    }
    const preflight = await run(
      executable,
      ["pilot", "check", "--pilot", "bundle-rehearsal", "--config", "launchrig.yml", "--json"],
      { cwd: installDirectory, env: rehearsalEnvironment, acceptedExitCodes: [2] },
    );
    const preflightOutput = preflight.stdout + "\n" + preflight.stderr;
    if (!preflightOutput.includes("pilot check requires --scope FILE")) {
      throw new Error("Clean consumer preflight did not require an approved private scope.");
    }
    const policyLint = await run(
      executable,
      ["pilot", "lint", "--config", "launchrig.yml", "--json"],
      { cwd: installDirectory, env: rehearsalEnvironment, acceptedExitCodes: [2] },
    );
    const policyLintOutput = policyLint.stdout + "\n" + policyLint.stderr;
    if (
      !policyLintOutput.includes('"kind": "launchrig-pilot-policy-lint"') ||
      !policyLintOutput.includes('"staticPolicyValid": false') ||
      !policyLintOutput.includes("Required MWA coverage is missing") ||
      policyLintOutput.includes("Android Device Ready") ||
      policyLintOutput.includes("Android/MWA Ready")
    ) {
      throw new Error("Clean consumer pilot lint did not safely refuse the unpromoted starter flows.");
    }

    const promotedScenarios = [
      ["authorize", "mwa-authorize", "Authorize"],
      ["siws", "mwa-siws", "Sign in with Solana"],
      ["sign-message", "mwa-sign-message", "Sign message"],
      ["reject", "mwa-reject", "Reject and recover"],
    ];
    for (const [id] of promotedScenarios) {
      await writeFile(
        path.join(installDirectory, "launchrig-flows", id + ".yaml"),
        [
          "appId: com.example.bundlerehearsal",
          "---",
          "- launchApp:",
          "    clearState: false",
          "- assertVisible:",
          "    id: bundle-rehearsal-" + id + "-ready",
          "",
        ].join("\n"),
        { flag: "wx", mode: 0o600 },
      );
    }
    const appApkPath = path.join(installDirectory, "bundle-rehearsal-app.apk");
    await writeFile(appApkPath, "bundle rehearsal app artifact v1\n", { flag: "wx", mode: 0o600 });
    const starterSource = await readFile(path.join(installDirectory, "launchrig.yml"), "utf8");
    const promotedConfig = starterSource
      .replace("  # apk: ./build/app-devnet.apk", "  apk: ./bundle-rehearsal-app.apk")
      .replace(
        "scenarios: []",
        [
          "scenarios:",
          ...promotedScenarios.flatMap(([id, kind, name]) => [
            "  - id: " + id,
            "    kind: " + kind,
            "    name: " + name,
            "    flow: ./launchrig-flows/" + id + ".yaml",
            "    required: true",
          ]),
        ].join("\n"),
      );
    await writeFile(path.join(installDirectory, "launchrig.yml"), promotedConfig, "utf8");
    const promotedLint = JSON.parse(
      (
        await run(executable, ["pilot", "lint", "--config", "launchrig.yml", "--json"], {
          cwd: installDirectory,
          env: rehearsalEnvironment,
        })
      ).stdout,
    );
    if (
      promotedLint.staticPolicyValid !== true ||
      promotedLint.deviceEnvironmentChecked !== false ||
      promotedLint.grantReady !== false
    ) {
      throw new Error("Clean consumer promoted policy did not pass its device-free lint.");
    }

    const scopePath = path.join(installDirectory, "private-session-scope.json");
    const preparation = JSON.parse(
      (
        await run(
          executable,
          [
            "pilot",
            "prepare-scope",
            "--config",
            "launchrig.yml",
            "--bundle",
            bundleDirectory,
            "--expires-on",
            "2099-12-31",
            "--deletion-method",
            "publisher-managed",
            "--output",
            scopePath,
            "--json",
          ],
          { cwd: installDirectory, env: rehearsalEnvironment },
        )
      ).stdout,
    );
    const scopeBytes = await readFile(scopePath);
    const scopeInput = JSON.parse(scopeBytes.toString("utf8"));
    const scopeMetadata = await lstat(scopePath);
    if (
      preparation.kind !== "launchrig-pilot-session-scope-draft-result" ||
      preparation.status !== "created" ||
      preparation.bundleVerification?.status !== "passed" ||
      preparation.policyValid !== true ||
      preparation.reviewRequired !== true ||
      preparation.approvalReceiptCreated !== false ||
      preparation.pilotStateChecked !== false ||
      preparation.deviceEnvironmentChecked !== false ||
      preparation.bundleAuthenticity !== "not-established" ||
      preparation.externalGrantGate !== "not-established" ||
      preparation.grantReady !== false ||
      Object.values(scopeInput.policy?.sharing ?? {}).some((value) => value !== false) ||
      !scopeMetadata.isFile() ||
      scopeMetadata.nlink !== 1 ||
      (process.platform !== "win32" && (scopeMetadata.mode & 0o777) !== 0o600) ||
      JSON.stringify(preparation).includes(scopePath) ||
      JSON.stringify(preparation).includes("urn:launchrig:") ||
      JSON.stringify(preparation).includes("Android Device Ready") ||
      JSON.stringify(preparation).includes("Android/MWA Ready")
    ) {
      throw new Error("Clean consumer scope preparation did not preserve its device-free claim-limited contract.");
    }
    const scopeReceipt = JSON.parse(
      (await run(executable, ["pilot", "scope", scopePath, "--json"], {
        cwd: installDirectory,
        env: rehearsalEnvironment,
      })).stdout,
    );
    if (
      scopeReceipt.kind !== "launchrig-pilot-session-scope-receipt" ||
      scopeReceipt.binding?.bundleId !== scopeInput.bundle.bundleId ||
      scopeReceipt.binding?.packageSha256 !== scopeInput.bundle.packageSha256 ||
      scopeReceipt.bundleVerification?.manifestSha256 !== scopeInput.bundle.manifestSha256 ||
      scopeReceipt.bundleVerification?.sha256SumsSha256 !== scopeInput.bundle.sha256SumsSha256 ||
      scopeReceipt.scopeFileSha256 !== createHash("sha256").update(scopeBytes).digest("hex") ||
      scopeReceipt.policyValid !== true ||
      scopeReceipt.claimStatus !== "operator-prepared-unattested" ||
      scopeReceipt.externalGrantGate !== "not-established" ||
      scopeReceipt.grantReady !== false ||
      JSON.stringify(scopeReceipt).includes(scopePath) ||
      JSON.stringify(scopeReceipt).includes("urn:launchrig:")
    ) {
      throw new Error("Clean consumer session scope receipt did not preserve its private claim-limited contract.");
    }
    await writeFile(appApkPath, "bundle rehearsal app artifact changed after approval\n", { mode: 0o600 });
    const scopedPreflight = await run(
      executable,
      [
        "pilot",
        "check",
        "--pilot",
        "bundle-rehearsal",
        "--scope",
        scopePath,
        "--config",
        "launchrig.yml",
        "--json",
      ],
      { cwd: installDirectory, env: rehearsalEnvironment, acceptedExitCodes: [2] },
    );
    const scopedPreflightOutput = scopedPreflight.stdout + "\n" + scopedPreflight.stderr;
    if (
      !scopedPreflightOutput.includes("Configured app APK bytes do not match the approved scope") ||
      !scopedPreflightOutput.includes('"status": "skip"')
    ) {
      throw new Error("Clean consumer scoped preflight did not refuse mismatched inputs before device checks.");
    }
    await rehearseInstalledScopeLinkedGovernance(
      executable,
      installDirectory,
      launchRigVersion,
      rehearsalEnvironment,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function buildBundle(output) {
  const sourceCommit = await assertCleanSource();
  const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (
    packageMetadata.name !== "launchrig" ||
    packageMetadata.private !== true ||
    !/^\d+\.\d+\.\d+$/.test(packageMetadata.version)
  ) {
    throw new Error("package.json does not satisfy the private LaunchRig release contract.");
  }
  const versionSource = await readFile(path.join(root, "src", "version.ts"), "utf8");
  const versionMatch = versionSource.match(/LAUNCHRIG_VERSION\s*=\s*"([^"]+)"/);
  if (versionMatch?.[1] !== packageMetadata.version) {
    throw new Error("package.json and src/version.ts must declare the same LaunchRig version.");
  }
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageMetadata.packageManager)) {
    throw new Error("package.json must declare an exact pnpm package manager version.");
  }
  const sourceEnvironment = { ...process.env };
  for (const key of ["ANDROID_SERIAL", "LAUNCHRIG_ADB_PATH", "LAUNCHRIG_MAESTRO_PATH", "NODE_OPTIONS", "NODE_PATH"]) {
    delete sourceEnvironment[key];
  }
  const expectedPnpmVersion = packageMetadata.packageManager.slice("pnpm@".length);
  const actualPnpmVersion = (await run(pnpm, ["--version"], { env: sourceEnvironment })).stdout;
  if (actualPnpmVersion !== expectedPnpmVersion) {
    throw new Error(
      "Release bundling requires pnpm " + expectedPnpmVersion + "; received " + (actualPnpmVersion || "no version") + ".",
    );
  }
  await run(
    pnpm,
    ["install", "--frozen-lockfile", "--offline", "--force", "--ignore-scripts", "--verify-store-integrity"],
    { env: sourceEnvironment },
  );
  const restoredSourceCommit = await assertCleanSource();
  if (restoredSourceCommit !== sourceCommit) throw new Error("Dependency restoration changed the release source.");
  const lockfileSha256 = createHash("sha256")
    .update(await readFile(path.join(root, "pnpm-lock.yaml")))
    .digest("hex");
  const destination = await resolveNewOutputDirectory(output);
  const stagingDirectory = await mkdtemp(path.join(destination.parentDirectory, ".launchrig-bundle-staging-"));
  const stagingIdentity = await lstat(stagingDirectory, { bigint: true });
  let outputCreated = false;
  let outputIdentity;
  let outputHandle;
  try {
    await run(pnpm, ["run", "check"], { env: sourceEnvironment });
    await run(pnpm, ["test"], { env: sourceEnvironment });
    await run(pnpm, ["run", "package:smoke"], { env: sourceEnvironment });
    const verifiedSourceCommit = await assertCleanSource();
    if (verifiedSourceCommit !== sourceCommit) throw new Error("Source commit changed during source verification.");

    await run(pnpm, ["pack", "--pack-destination", stagingDirectory], { env: sourceEnvironment });
    const archives = (await readdir(stagingDirectory)).filter((entry) => entry.endsWith(".tgz"));
    const expectedArchiveName = "launchrig-" + packageMetadata.version + ".tgz";
    if (archives.length !== 1 || archives[0] !== expectedArchiveName) {
      throw new Error("Expected exactly " + expectedArchiveName + " from pnpm pack.");
    }
    const archivePath = path.join(stagingDirectory, expectedArchiveName);

    await copyBundleMaterials(stagingDirectory);
    const rehearsalFiles = await collectPayloadEntries(stagingDirectory);
    const packageBeforeRehearsal = rehearsalFiles.find(
      (entry) => entry.path === expectedArchiveName,
    );
    if (!packageBeforeRehearsal) throw new Error("Packed archive is missing before the consumer rehearsal.");
    const rehearsalManifest = createPublisherManifest({
      launchRigVersion: packageMetadata.version,
      gitCommit: sourceCommit,
      lockfileSha256,
      nodeEngine: packageMetadata.engines.node,
      packageManager: packageMetadata.packageManager,
      packagePath: expectedArchiveName,
      files: rehearsalFiles,
    });
    await writeFile(
      path.join(stagingDirectory, "manifest.json"),
      JSON.stringify(rehearsalManifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      path.join(stagingDirectory, "SHA256SUMS"),
      renderSha256Sums(rehearsalFiles),
      { flag: "wx", mode: 0o600 },
    );
    await verifyPublisherBundle(stagingDirectory);
    await rehearseCleanConsumer(archivePath, packageMetadata.version, stagingDirectory);
    await verifyPublisherBundle(stagingDirectory);
    await unlink(path.join(stagingDirectory, "manifest.json"));
    await unlink(path.join(stagingDirectory, "SHA256SUMS"));
    const finalSourceCommit = await assertCleanSource();
    if (finalSourceCommit !== sourceCommit) throw new Error("Source commit changed during bundle assembly.");

    const files = await collectPayloadEntries(stagingDirectory);
    const packageAfterRehearsal = files.find((entry) => entry.path === expectedArchiveName);
    if (
      !packageAfterRehearsal ||
      packageAfterRehearsal.sizeBytes !== packageBeforeRehearsal.sizeBytes ||
      packageAfterRehearsal.sha256 !== packageBeforeRehearsal.sha256
    ) {
      throw new Error("Packed archive changed during the clean consumer rehearsal.");
    }
    const manifest = createPublisherManifest({
      launchRigVersion: packageMetadata.version,
      gitCommit: sourceCommit,
      lockfileSha256,
      nodeEngine: packageMetadata.engines.node,
      packageManager: packageMetadata.packageManager,
      packagePath: expectedArchiveName,
      files,
    });
    if (JSON.stringify(manifest) !== JSON.stringify(rehearsalManifest)) {
      throw new Error("Publisher bundle identity changed after the clean consumer rehearsal.");
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
    const sumsBytes = Buffer.from(renderSha256Sums(files), "utf8");
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    const sumsSha256 = createHash("sha256").update(sumsBytes).digest("hex");
    await writeFile(path.join(stagingDirectory, "manifest.json"), manifestBytes, {
      flag: "wx",
      mode: 0o644,
    });
    await writeFile(path.join(stagingDirectory, "SHA256SUMS"), sumsBytes, {
      flag: "wx",
      mode: 0o644,
    });
    await verifyPublisherBundle(stagingDirectory);

    await mkdir(destination.outputDirectory, { mode: 0o700 });
    outputCreated = true;
    outputIdentity = await lstat(destination.outputDirectory, { bigint: true });
    outputHandle = await open(
      destination.outputDirectory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    const openedOutput = await outputHandle.stat({ bigint: true });
    if (!openedOutput.isDirectory() || !sameDirectoryIdentity(openedOutput, outputIdentity)) {
      throw new Error("Publisher bundle output changed while being opened.");
    }
    for (const entry of (await readdir(stagingDirectory)).sort()) {
      await rename(
        path.join(stagingDirectory, entry),
        path.join(destination.outputDirectory, entry),
      );
    }
    await verifyPublisherBundle(destination.outputDirectory);
    const outputBeforePublish = await lstat(destination.outputDirectory, { bigint: true });
    const openedBeforePublish = await outputHandle.stat({ bigint: true });
    if (
      outputBeforePublish.isSymbolicLink() ||
      !outputBeforePublish.isDirectory() ||
      !openedBeforePublish.isDirectory() ||
      !sameDirectoryIdentity(outputBeforePublish, outputIdentity) ||
      !sameDirectoryIdentity(openedBeforePublish, outputIdentity)
    ) {
      throw new Error("Publisher bundle output changed before publication.");
    }
    const stagingRemoved = await removeStagingDirectoryIfUnchanged(stagingDirectory, stagingIdentity);
    if (!stagingRemoved) {
      console.warn("LaunchRig private staging directory changed and was left in place for manual inspection.");
    }
    await outputHandle.chmod(0o755);
    await verifyPublisherBundleAtIdentity(destination.outputDirectory, {
      dev: outputIdentity.dev,
      ino: outputIdentity.ino,
    });

    console.log("LaunchRig publisher bundle created and verified.");
    console.log("output: " + destination.outputDirectory);
    console.log("bundle id: " + manifest.bundleId);
    console.log("manifest sha256: " + manifestSha256);
    console.log("sha256sums sha256: " + sumsSha256);
    console.log("package sha256: " + manifest.package.sha256);
    console.log("consumer rehearsal: passed");
    console.log("device or wallet tested by this rehearsal: no");
    console.log("grant ready: no");
  } catch (error) {
    await outputHandle?.chmod(0o700).catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    const retained = [
      "Private staging data was left in place for manual inspection.",
      ...(outputCreated
        ? ["An incomplete mode-700 output directory may also remain and will not be removed automatically."]
        : []),
    ];
    throw new Error(detail + " " + retained.join(" "));
  } finally {
    await outputHandle?.close().catch(() => undefined);
  }
}

try {
  const argumentsResult = parseBundleArguments(process.argv.slice(2));
  if (argumentsResult.help) console.log(helpText());
  else await buildBundle(argumentsResult.output);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
