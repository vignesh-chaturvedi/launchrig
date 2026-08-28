import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_PROFILE } from "./pilot-bundle-lib.mjs";
import { inspectLaunchRigArchive } from "./verify-pilot-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrig-package-smoke-"));
const packageDirectory = path.join(temporaryDirectory, "package");
const installDirectory = path.join(temporaryDirectory, "install");
const publisherDirectory = path.join(temporaryDirectory, "publisher");
const emptyStoreDirectory = path.join(temporaryDirectory, "empty-store");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
      if (code === 0) resolve(result);
      else reject(new Error(result.stderr || result.stdout || command + " exited with code " + code));
    });
  });
}

async function collectFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Installed package must not contain symlinks: " + relative);
    if (entry.isDirectory()) files.push(...(await collectFiles(path.join(directory, entry.name), relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error("Installed package contains an unsupported entry: " + relative);
  }
  return files.sort();
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map((entry) => canonicalJson(entry)).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
      .join(",") +
    "}"
  );
}

function sha256Value(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

try {
  await mkdir(packageDirectory, { recursive: true });
  await run(pnpm, ["pack", "--pack-destination", packageDirectory]);
  const archives = (await readdir(packageDirectory)).filter((entry) => entry.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error("Expected exactly one LaunchRig package archive.");
  const archive = path.join(packageDirectory, archives[0]);

  await mkdir(installDirectory, { recursive: true });
  await mkdir(emptyStoreDirectory, { recursive: true });
  await run(pnpm, ["add", "--dir", installDirectory, "--offline", "--store-dir", emptyStoreDirectory, archive]);
  const installedDirectory = path.join(installDirectory, "node_modules", "launchrig");
  const installedPackage = JSON.parse(await readFile(path.join(installedDirectory, "package.json"), "utf8"));
  inspectLaunchRigArchive(await readFile(archive), {
    profile: BUNDLE_PROFILE,
    launchRigVersion: installedPackage.version,
    package: { nodeEngine: installedPackage.engines?.node },
  });
  const installedFiles = await collectFiles(installedDirectory);

  if (!installedFiles.includes("dist/src/cli.js")) throw new Error("Packed CLI entrypoint is missing.");
  if (!installedFiles.includes("schemas/launchrig.schema.json")) throw new Error("Packed config schema is missing.");
  if (!installedFiles.includes("schemas/launchrig-pilot-evidence.schema.json")) {
    throw new Error("Packed legacy pilot evidence v1 schema alias is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-pilot-evidence-v1.schema.json")) {
    throw new Error("Packed pilot evidence v1 schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-pilot-evidence-v2.schema.json")) {
    throw new Error("Packed pilot evidence v2 schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-publisher-bundle.schema.json")) {
    throw new Error("Packed publisher bundle schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-cohort-verification.schema.json")) {
    throw new Error("Packed cohort verification schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-private-cohort-register.schema.json")) {
    throw new Error("Packed private cohort register schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-private-cohort-audit.schema.json")) {
    throw new Error("Packed private cohort audit schema is missing.");
  }
  const publisherBundleSchema = JSON.parse(
    await readFile(path.join(installedDirectory, "schemas", "launchrig-publisher-bundle.schema.json"), "utf8"),
  );
  if (
    publisherBundleSchema.$id !== "https://launchrig.dev/schemas/launchrig-publisher-bundle.schema.json" ||
    publisherBundleSchema.additionalProperties !== false ||
    publisherBundleSchema.properties?.kind?.const !== "launchrig-publisher-bundle" ||
    JSON.stringify(publisherBundleSchema.properties?.profile?.enum) !==
      JSON.stringify([
        "phase-2a-publisher-rc-v1",
        "phase-2b-publisher-rc-v2",
        "phase-2c-publisher-rc-v3",
      ]) ||
    publisherBundleSchema.properties?.grantReady?.const !== false ||
    publisherBundleSchema.properties?.claims?.properties?.externalPublisher?.const !== "not-established" ||
    JSON.stringify(publisherBundleSchema.properties?.sourceVerification?.properties?.checks?.const) !==
      JSON.stringify([
        "package-manager-version",
        "frozen-offline-dependency-restore",
        "typecheck",
        "test-suite",
        "package-smoke",
      ])
  ) {
    throw new Error("Packed publisher bundle schema does not preserve the claim-limited contract.");
  }
  const cohortSchema = JSON.parse(
    await readFile(path.join(installedDirectory, "schemas", "launchrig-cohort-verification.schema.json"), "utf8"),
  );
  if (
    cohortSchema.$id !== "https://launchrig.dev/schemas/launchrig-cohort-verification.schema.json" ||
    cohortSchema.additionalProperties !== false ||
    cohortSchema.properties?.kind?.const !== "launchrig-cohort-verification" ||
    cohortSchema.properties?.grantReady?.const !== false ||
    cohortSchema.properties?.externalGrantGate?.properties?.status?.const !== "not-established" ||
    cohortSchema.properties?.evidence?.maxItems !== 25 ||
    cohortSchema.properties?.summary?.allOf?.[0]?.then?.properties?.technicallyQualifiedFiles?.minimum !== 3 ||
    cohortSchema.properties?.summary?.allOf?.[0]?.else?.properties?.technicallyQualifiedFiles?.maximum !== 2 ||
    cohortSchema.allOf?.[0]?.then?.properties?.evidence?.minContains !== 3 ||
    cohortSchema.allOf?.[0]?.else?.properties?.evidence?.maxContains !== 2 ||
    cohortSchema.$defs?.evidence?.oneOf?.[1]?.allOf?.[0]?.then?.properties?.setupDurationMs?.maximum !==
      1800000 ||
    cohortSchema.$defs?.evidence?.oneOf?.[1]?.allOf?.[0]?.then?.properties?.medianRunDurationMs?.maximum !==
      600000 ||
    cohortSchema.$defs?.evidence?.oneOf?.[1]?.allOf?.[0]?.then?.properties?.trailingMwaPasses?.minimum !== 3
  ) {
    throw new Error("Packed cohort schema does not preserve the claim-limited contract.");
  }
  const privateRegisterSchema = JSON.parse(
    await readFile(path.join(installedDirectory, "schemas", "launchrig-private-cohort-register.schema.json"), "utf8"),
  );
  const privateAuditSchema = JSON.parse(
    await readFile(path.join(installedDirectory, "schemas", "launchrig-private-cohort-audit.schema.json"), "utf8"),
  );
  if (
    privateRegisterSchema.$id !==
      "https://launchrig.dev/schemas/launchrig-private-cohort-register.schema.json" ||
    privateRegisterSchema.additionalProperties !== false ||
    privateRegisterSchema.properties?.privacyProfile?.const !== "opaque-refs-digests-dates-v1" ||
    privateRegisterSchema.properties?.candidates?.maxItems !== 25 ||
    privateRegisterSchema.$defs?.candidate?.additionalProperties !== false ||
    privateRegisterSchema.$defs?.evidenceBinding?.properties?.schemaVersion?.enum?.join(",") !== "1,2"
  ) {
    throw new Error("Packed private cohort register schema does not preserve the privacy contract.");
  }
  if (
    privateAuditSchema.$id !== "https://launchrig.dev/schemas/launchrig-private-cohort-audit.schema.json" ||
    privateAuditSchema.additionalProperties !== false ||
    privateAuditSchema.properties?.kind?.const !== "launchrig-private-cohort-register-audit" ||
    privateAuditSchema.properties?.grantReady?.const !== false ||
    privateAuditSchema.properties?.externalGrantGate?.properties?.status?.const !== "not-established" ||
    privateAuditSchema.properties?.entries?.maxItems !== 25
  ) {
    throw new Error("Packed private cohort audit schema does not preserve the claim-limited contract.");
  }
  const expectedDocuments = [
    "docs/cohort-audit.md",
    "docs/cohort-verification.md",
    "docs/phase-1.md",
    "docs/phase-2.md",
    "docs/physical-device.md",
    "docs/publisher-bundle-readme.md",
    "docs/publisher-pilot-quickstart.md",
    "docs/supported-environment.md",
    "docs/flows/mwa-authorize.md",
    "docs/flows/mwa-reject.md",
    "docs/flows/mwa-sign-message.md",
    "docs/flows/mwa-siws.md",
  ];
  for (const document of expectedDocuments) {
    if (!installedFiles.includes(document)) throw new Error("Packed documentation is missing " + document + ".");
  }
  const expectedTemplates = [
    "templates/pilot-consent.md",
    "templates/pilot-notes.md",
    "templates/defect-evidence.md",
    "templates/publisher-intake.md",
    "templates/sharing-review.md",
  ];
  for (const template of expectedTemplates) {
    if (!installedFiles.includes(template)) throw new Error("Packed template is missing " + template + ".");
  }
  const expectedSchemas = [
    "schemas/launchrig-cohort-verification.schema.json",
    "schemas/launchrig-pilot-evidence-v1.schema.json",
    "schemas/launchrig-pilot-evidence-v2.schema.json",
    "schemas/launchrig-pilot-evidence.schema.json",
    "schemas/launchrig-private-cohort-audit.schema.json",
    "schemas/launchrig-private-cohort-register.schema.json",
    "schemas/launchrig-publisher-bundle.schema.json",
    "schemas/launchrig.schema.json",
  ];
  for (const [label, expected, prefix] of [
    ["documentation", expectedDocuments, "docs/"],
    ["schema", expectedSchemas, "schemas/"],
    ["template", expectedTemplates, "templates/"],
  ]) {
    const actual = installedFiles.filter((file) => file.startsWith(prefix)).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
      throw new Error("Packed " + label + " inventory does not match the release allowlist.");
    }
  }
  const allowedPackageFile = (file) =>
    file === "LICENSE" ||
    file === "README.md" ||
    file === "package.json" ||
    file === "node_modules/.bin/launchrig" ||
    file === "node_modules/.bin/launchrig.CMD" ||
    file === "node_modules/.bin/launchrig.ps1" ||
    file.startsWith("dist/src/") ||
    file.startsWith("dist/node_modules/yaml/") ||
    file.startsWith("docs/") ||
    file.startsWith("schemas/") ||
    file.startsWith("templates/");
  const unexpectedPackageFile = installedFiles.find((file) => !allowedPackageFile(file));
  if (unexpectedPackageFile) throw new Error("Packed archive contains an unexpected file: " + unexpectedPackageFile);
  const forbiddenPackageFile = installedFiles.find(
    (file) =>
      file.startsWith(".launchrig/") ||
      file.startsWith(".git/") ||
      file.startsWith("apps/") ||
      file.startsWith("fixtures/") ||
      file.startsWith("scripts/") ||
      file.startsWith("test/") ||
      file.endsWith(".apk") ||
      file.endsWith(".log") ||
      path.posix.basename(file).startsWith(".env"),
  );
  if (forbiddenPackageFile) throw new Error("Packed archive contains forbidden private material: " + forbiddenPackageFile);
  if (installedFiles.some((file) => file.startsWith("dist/test/"))) {
    throw new Error("Packed archive must not contain the test suite.");
  }
  if (!installedFiles.includes("dist/node_modules/yaml/package.json")) {
    throw new Error("Packed archive is missing the pinned YAML runtime.");
  }
  if (!installedFiles.includes("dist/node_modules/yaml/LICENSE")) {
    throw new Error("Packed archive is missing the YAML runtime license.");
  }
  for (const file of installedFiles.filter(
    (entry) => entry.startsWith("dist/src/") && /\.(?:js|d\.ts|map|json)$/.test(entry),
  )) {
    const source = await readFile(path.join(installedDirectory, ...file.split("/")), "utf8");
    if (source.includes(root) || source.includes(os.homedir())) {
      throw new Error("Packed source output exposes an absolute local path: " + file);
    }
  }
  if (installedPackage.private !== true) throw new Error("Packed package must remain private.");

  const executable = path.join(
    installDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "launchrig.cmd" : "launchrig",
  );
  const version = await run(executable, ["--version"], { cwd: installDirectory });
  if (version.stdout !== installedPackage.version) {
    throw new Error(
      "Installed CLI version " + JSON.stringify(version.stdout) +
        " does not match package metadata " + JSON.stringify(installedPackage.version) + ".",
    );
  }
  const help = await run(executable, ["--help"], { cwd: installDirectory });
  if (!help.stdout.includes("launchrig pilot verify FILE")) {
    throw new Error("Installed CLI help is missing the public evidence verifier.");
  }
  if (!help.stdout.includes("launchrig pilot check --pilot ID")) {
    throw new Error("Installed CLI help is missing the publisher pilot preflight.");
  }
  if (!help.stdout.includes("launchrig cohort verify FILE...")) {
    throw new Error("Installed CLI help is missing the Phase 2B cohort verifier.");
  }
  if (!help.stdout.includes("launchrig cohort audit REGISTER [EVIDENCE...]")) {
    throw new Error("Installed CLI help is missing the Phase 2C private cohort audit.");
  }

  const privateRegisterCore = {
    schemaVersion: 1,
    kind: "launchrig-private-cohort-register",
    profile: "phase-2c-publisher-governance-v1",
    privacyProfile: "opaque-refs-digests-dates-v1",
    registerRef: "urn:launchrig:register:123e4567-e89b-42d3-a456-426614174000",
    revision: 1,
    asOfDate: "2026-08-28",
    operatorRef: "urn:launchrig:operator:223e4567-e89b-42d3-a456-426614174000",
    candidates: [],
    defects: [],
  };
  const privateRegisterPath = path.join(temporaryDirectory, "private-cohort-register.json");
  await writeFile(
    privateRegisterPath,
    JSON.stringify(
      { ...privateRegisterCore, integritySha256: sha256Value(privateRegisterCore) },
      null,
      2,
    ) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(privateRegisterPath, 0o600);
  const privateAudit = JSON.parse(
    (await run(executable, ["cohort", "audit", privateRegisterPath, "--json"], { cwd: installDirectory })).stdout,
  );
  if (
    privateAudit.kind !== "launchrig-private-cohort-register-audit" ||
    privateAudit.register?.integrityRecorded !== true ||
    privateAudit.summary?.candidateRecords !== 0 ||
    privateAudit.summary?.recordedGovernanceAndTechnicalThresholdMet !== false ||
    privateAudit.externalGrantGate?.status !== "not-established" ||
    privateAudit.grantReady !== false ||
    JSON.stringify(privateAudit).includes(privateRegisterPath)
  ) {
    throw new Error("Installed private cohort audit did not preserve its privacy and claim limits.");
  }

  await mkdir(publisherDirectory, { recursive: true });
  await run(executable, ["pilot", "start", "--pilot", "package-smoke", "--config", "launchrig.yml"], {
    cwd: publisherDirectory,
  });
  await run(executable, ["init", "--name", "Package Smoke App", "--package", "com.example.packagesmoke"], {
    cwd: publisherDirectory,
  });
  const validation = await run(executable, ["validate", "--config", "launchrig.yml"], {
    cwd: publisherDirectory,
  });
  if (!validation.stdout.includes("Configuration valid")) {
    throw new Error("Installed publisher starter configuration did not validate.");
  }
  let preflightFailure;
  try {
    await run(
      executable,
      ["pilot", "check", "--pilot", "package-smoke", "--config", "launchrig.yml", "--json"],
      { cwd: publisherDirectory },
    );
  } catch (error) {
    preflightFailure = error;
  }
  if (
    !(preflightFailure instanceof Error) ||
    !preflightFailure.message.includes("Required MWA coverage is missing") ||
    !preflightFailure.message.includes('"status": "skip"')
  ) {
    throw new Error("Installed pilot preflight did not reject the incomplete starter without device access.");
  }
  const ignoreSource = await readFile(path.join(publisherDirectory, ".gitignore"), "utf8");
  if (!ignoreSource.split(/\r?\n/).includes(".launchrig/")) {
    throw new Error("Installed init did not ignore private LaunchRig state.");
  }
  for (const flow of ["mwa-authorize", "mwa-siws", "mwa-sign-message", "mwa-reject"]) {
    await readFile(path.join(publisherDirectory, "launchrig-flows", flow + ".example.yaml"), "utf8");
  }

  const claims = {
    externalPublisher: "not-established",
    seekerHardware: "not-established",
    productionWallet: "not-established",
    seedVault: "not-established",
    confirmedDefect: "not-established",
  };
  const emptyMetrics = {
    runAttempts: 0,
    qualifyingRuns: 0,
    passRate: 0,
    consecutivePasses: 0,
    medianRunDurationMs: null,
    setupDurationMs: null,
    executionFingerprintSha256: null,
    setupTargetMet: false,
    runtimeTargetMet: false,
    repeatabilityTargetMet: false,
  };
  const evidenceV1Core = {
    schemaVersion: 1,
    kind: "launchrig-pilot-evidence",
    evidenceId: "123e4567-e89b-42d3-a456-426614174000",
    claimStatus: "self-recorded-unattested",
    metrics: emptyMetrics,
    runs: [],
    claims,
  };
  const evidenceV1Path = path.join(publisherDirectory, "pilot-evidence-v1.json");
  await writeFile(
    evidenceV1Path,
    JSON.stringify({ ...evidenceV1Core, evidenceSha256: sha256Value(evidenceV1Core) }, null, 2) + "\n",
    "utf8",
  );
  const verificationV1 = JSON.parse(
    (await run(executable, ["pilot", "verify", evidenceV1Path, "--json"], { cwd: publisherDirectory })).stdout,
  );
  if (
    verificationV1.schemaVersion !== 1 ||
    verificationV1.technicalPilot !== null ||
    verificationV1.reportedTechnicalTargetsMet !== false ||
    verificationV1.grantReady !== false
  ) {
    throw new Error("Installed verifier did not retain evidence v1 compatibility.");
  }

  const evidenceV2NotMetCore = {
    schemaVersion: 2,
    kind: "launchrig-pilot-evidence",
    evidenceId: "223e4567-e89b-42d3-a456-426614174000",
    claimStatus: "self-recorded-unattested",
    metrics: emptyMetrics,
    technicalPilot: {
      profile: "external-mwa-pilot-v1",
      qualified: false,
      latestReadiness: null,
      trailingMwaPasses: 0,
      requiredTrailingMwaPasses: 3,
      setupDurationMs: null,
      medianRunDurationMs: null,
      setupTargetMet: false,
      runtimeTargetMet: false,
      repeatabilityTargetMet: false,
    },
    runs: [],
    claims,
  };
  const evidenceV2NotMetPath = path.join(publisherDirectory, "pilot-evidence-v2-not-met.json");
  await writeFile(
    evidenceV2NotMetPath,
    JSON.stringify(
      {
        ...evidenceV2NotMetCore,
        evidenceSha256: sha256Value(evidenceV2NotMetCore),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const verification = await run(executable, ["pilot", "verify", evidenceV2NotMetPath], {
    cwd: publisherDirectory,
  });
  if (
    !verification.stdout.includes("Public pilot evidence: internally consistent") ||
    !verification.stdout.includes("evidence schema: v2") ||
    !verification.stdout.includes("technical pilot gate (recomputed from self-recorded fields): not met") ||
    !verification.stdout.includes("external grant gate: not established") ||
    !verification.stdout.includes("grant ready: no")
  ) {
    throw new Error("Installed public evidence verifier did not preserve claim limitations.");
  }
  const verificationV2NotMet = JSON.parse(
    (
      await run(executable, ["pilot", "verify", evidenceV2NotMetPath, "--json"], {
        cwd: publisherDirectory,
      })
    ).stdout,
  );
  if (
    verificationV2NotMet.schemaVersion !== 2 ||
    verificationV2NotMet.technicalPilot?.qualified !== false ||
    verificationV2NotMet.reportedTechnicalTargetsMet !== false ||
    verificationV2NotMet.grantReady !== false
  ) {
    throw new Error("Installed verifier returned an invalid evidence v2 not-met result.");
  }

  const fingerprint = "a".repeat(64);
  const evidenceV2MetCore = {
    schemaVersion: 2,
    kind: "launchrig-pilot-evidence",
    evidenceId: "323e4567-e89b-42d3-a456-426614174000",
    claimStatus: "self-recorded-unattested",
    metrics: {
      runAttempts: 3,
      qualifyingRuns: 3,
      passRate: 1,
      consecutivePasses: 3,
      medianRunDurationMs: 5 * 60_000,
      setupDurationMs: 20 * 60_000,
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
      setupDurationMs: 20 * 60_000,
      medianRunDurationMs: 5 * 60_000,
      setupTargetMet: true,
      runtimeTargetMet: true,
      repeatabilityTargetMet: true,
    },
    runs: [20, 25, 30].map((elapsedMinutes, index) => ({
      runId: "run-" + String(index + 1).padStart(3, "0"),
      outcome: "passed",
      readiness: "Android/MWA Ready",
      durationMs: 5 * 60_000,
      elapsedSinceStartMs: elapsedMinutes * 60_000,
      executionFingerprintSha256: fingerprint,
      launchRigVersion: installedPackage.version,
      physicalDevice: true,
      requiredChecksPassed: true,
      qualifying: true,
    })),
    claims,
  };
  const evidenceV2MetPath = path.join(publisherDirectory, "pilot-evidence-v2-met.json");
  await writeFile(
    evidenceV2MetPath,
    JSON.stringify(
      {
        ...evidenceV2MetCore,
        evidenceSha256: sha256Value(evidenceV2MetCore),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const verificationV2Met = JSON.parse(
    (
      await run(executable, ["pilot", "verify", evidenceV2MetPath, "--json"], {
        cwd: publisherDirectory,
      })
    ).stdout,
  );
  if (
    verificationV2Met.schemaVersion !== 2 ||
    verificationV2Met.technicalPilot?.qualified !== true ||
    verificationV2Met.reportedTechnicalTargetsMet !== true ||
    verificationV2Met.grantReady !== false
  ) {
    throw new Error("Installed verifier did not recompute a valid evidence v2 technical gate.");
  }

  let matrixFailure;
  try {
    await run(executable, ["matrix"], { cwd: installDirectory });
  } catch (error) {
    matrixFailure = error;
  }
  if (!(matrixFailure instanceof Error) || !matrixFailure.message.includes("source checkout")) {
    throw new Error("Installed matrix command must refuse execution outside a source checkout.");
  }

  console.log("LaunchRig package smoke test passed for " + installedPackage.version + ".");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
