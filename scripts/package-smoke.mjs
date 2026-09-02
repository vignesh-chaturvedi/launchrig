import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  BUNDLE_PROFILE,
  collectPayloadEntries,
  createPublisherManifest,
  renderSha256Sums,
} from "./pilot-bundle-lib.mjs";
import { inspectLaunchRigArchive, verifyPublisherBundle } from "./verify-pilot-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "launchrig-package-smoke-")),
);
const packageDirectory = path.join(temporaryDirectory, "package");
const installDirectory = path.join(temporaryDirectory, "install");
const publisherDirectory = path.join(temporaryDirectory, "publisher");
const emptyStoreDirectory = path.join(temporaryDirectory, "empty-store");
const verifiedBundleDirectory = path.join(temporaryDirectory, "verified-publisher-bundle");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const OUTER_BUNDLE_COPY_MAP = [
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

function smokeDigest(label) {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function smokeUuid(index) {
  const value = index.toString(16);
  return value.padStart(8, "0") + "-0000-4000-a000-" + value.padStart(12, "0");
}

function smokeRef(kind, index) {
  return "urn:launchrig:" + kind + ":" + smokeUuid(index);
}

async function createVerifiedPublisherBundle(archive, version) {
  await mkdir(verifiedBundleDirectory, { recursive: true, mode: 0o700 });
  const packagePath = "launchrig-" + version + ".tgz";
  await copyFile(archive, path.join(verifiedBundleDirectory, packagePath));
  for (const [source, destination] of OUTER_BUNDLE_COPY_MAP) {
    const target = path.join(verifiedBundleDirectory, ...destination.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path.join(root, ...source.split("/")), target);
  }
  const files = await collectPayloadEntries(verifiedBundleDirectory);
  const manifest = createPublisherManifest({
    profile: BUNDLE_PROFILE,
    launchRigVersion: version,
    gitCommit: "a".repeat(40),
    lockfileSha256: "b".repeat(64),
    nodeEngine: ">=20.11",
    packageManager: "pnpm@10.34.0",
    packagePath,
    files,
  });
  await writeFile(
    path.join(verifiedBundleDirectory, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    path.join(verifiedBundleDirectory, "SHA256SUMS"),
    renderSha256Sums(files),
    { flag: "wx", mode: 0o600 },
  );
  await verifyPublisherBundle(verifiedBundleDirectory);
  return manifest;
}

function privateCandidate(index, evidenceBinding, scopeSha256) {
  return {
    candidateRef: smokeRef("candidate", 100 + index),
    publisherRef: smokeRef("publisher", 200 + index),
    projectRef: smokeRef("project", 300 + index),
    lineageRef: smokeRef("lineage", 400 + index),
    pilotRef: smokeRef("pilot", 500 + index),
    recruitment: {
      status: "interest-recorded",
      recordSha256: smokeDigest("recruitment-" + index),
      statusOn: "2026-08-01",
    },
    intakeReview: {
      status: "operator-recorded-sufficient",
      recordSha256: smokeDigest("intake-" + index),
      reviewedOn: "2026-08-02",
      reviewerRef: smokeRef("reviewer", 600 + index),
    },
    independenceReview: {
      status: "operator-recorded-eligible",
      recordSha256: smokeDigest("independence-" + index),
      reviewedOn: "2026-08-03",
      reviewerRef: smokeRef("reviewer", 700 + index),
      relationshipCodes: ["none-declared"],
    },
    consent: {
      status: "operator-recorded-active",
      recordSha256: smokeDigest("consent-" + index),
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
        bundleId: "sha256:" + smokeDigest("bundle-" + index),
        packageSha256: smokeDigest("package-" + index),
        appBuildSha256: smokeDigest("app-build-" + index),
        walletArtifactSha256: smokeDigest("wallet-" + index),
        flowReviewSha256: smokeDigest("flow-review-" + index),
        scopeSha256,
      },
    },
    evidence: {
      sharingStatus: "operator-recorded-approved",
      binding: evidenceBinding,
      decisionRecordSha256: smokeDigest("sharing-" + index),
      decidedOn: "2026-08-11",
      withdrawalRecordSha256: null,
      withdrawnOn: null,
    },
    closeout: {
      status: "operator-recorded-complete",
      recordSha256: smokeDigest("closeout-" + index),
      completedOn: "2026-08-12",
    },
    countDecision: {
      status: "operator-recorded-include",
      recordSha256: smokeDigest("count-" + index),
      reviewedOn: "2026-08-13",
      reviewerRef: smokeRef("reviewer", 800 + index),
      reasonCodes: ["meets-recorded-policy"],
    },
  };
}

function sealedPrivateRegister(candidates, index) {
  const core = {
    schemaVersion: 1,
    kind: "launchrig-private-cohort-register",
    profile: "phase-2c-publisher-governance-v1",
    privacyProfile: "opaque-refs-digests-dates-v1",
    registerRef: smokeRef("register", index),
    revision: 1,
    asOfDate: "2026-08-28",
    operatorRef: smokeRef("operator", index),
    candidates,
    defects: [],
  };
  return { ...core, integritySha256: sha256Value(core) };
}

function externalGateIsNotEstablished(gate) {
  return (
    gate &&
    Object.keys(gate).length === 8 &&
    Object.values(gate).every((value) => value === "not-established")
  );
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
  const verifiedBundleManifest = await createVerifiedPublisherBundle(archive, installedPackage.version);
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
  if (!installedFiles.includes("schemas/launchrig-pilot-evidence-v3.schema.json")) {
    throw new Error("Packed pilot evidence v3 schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-pilot-evidence-binding-receipt.schema.json")) {
    throw new Error("Packed pilot evidence binding receipt schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-pilot-session-scope.schema.json")) {
    throw new Error("Packed pilot session scope schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-pilot-session-scope-receipt.schema.json")) {
    throw new Error("Packed pilot session scope receipt schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-pilot-session-scope-draft-result.schema.json")) {
    throw new Error("Packed pilot session scope draft result schema is missing.");
  }
  for (const runtimeFile of ["scripts/runtime-contract.mjs", "scripts/verify-pilot-bundle.mjs"]) {
    if (!installedFiles.includes(runtimeFile)) {
      throw new Error("Packed scope preparation verifier is missing " + runtimeFile + ".");
    }
  }
  if (!installedFiles.includes("dist/src/pilot/scope-preparation.js")) {
    throw new Error("Packed pilot scope preparation implementation is missing.");
  }
  if (!installedFiles.includes("dist/src/pilot/cohort-preparation.js")) {
    throw new Error("Packed private cohort register preparation implementation is missing.");
  }
  if (!installedFiles.includes("dist/src/pilot/prospect-review.js")) {
    throw new Error("Packed private prospect review implementation is missing.");
  }
  if (!installedFiles.includes("dist/src/pilot/send-decision-preparation.js")) {
    throw new Error("Packed private send decision preparation implementation is missing.");
  }
  if (!installedFiles.includes("dist/src/pilot/send-decision-recording.js")) {
    throw new Error("Packed private human send decision implementation is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-publisher-bundle.schema.json")) {
    throw new Error("Packed publisher bundle schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-cohort-verification.schema.json")) {
    throw new Error("Packed cohort verification schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-core-rule-catalog.schema.json")) {
    throw new Error("Packed core rule catalog schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-private-cohort-register.schema.json")) {
    throw new Error("Packed private cohort register schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-private-cohort-register-draft-result.schema.json")) {
    throw new Error("Packed private cohort register draft result schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-private-cohort-audit.schema.json")) {
    throw new Error("Packed private cohort audit schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-private-prospect-review.schema.json")) {
    throw new Error("Packed private prospect review schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-private-prospect-review-result.schema.json")) {
    throw new Error("Packed private prospect review result schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-private-send-decision-request.schema.json")) {
    throw new Error("Packed private send decision request schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-private-send-decision-request-result.schema.json")) {
    throw new Error("Packed private send decision request result schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-private-human-send-decision.schema.json")) {
    throw new Error("Packed private human send decision schema is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-private-human-send-decision-result.schema.json")) {
    throw new Error("Packed private human send decision result schema is missing.");
  }
  if (!installedFiles.includes("schemas/fixtures/launchrig-config-v1.conformance.json")) {
    throw new Error("Packed config v1 conformance corpus is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-config-validation-result.schema.json")) {
    throw new Error("Packed structured configuration result schema is missing.");
  }
  if (!installedFiles.includes("schemas/fixtures/launchrig-config-rule-fixtures.v1.json")) {
    throw new Error("Packed configuration rule fixture corpus is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-runtime-rule-fixtures.schema.json")) {
    throw new Error("Packed runtime rule fixture schema is missing.");
  }
  if (!installedFiles.includes("schemas/fixtures/launchrig-runtime-rule-fixtures.v1.json")) {
    throw new Error("Packed runtime rule fixture corpus is missing.");
  }
  if (!installedFiles.includes("schemas/launchrig-pilot-rule-fixtures.schema.json")) {
    throw new Error("Packed pilot rule fixture schema is missing.");
  }
  if (!installedFiles.includes("schemas/fixtures/launchrig-pilot-rule-fixtures.v1.json")) {
    throw new Error("Packed pilot rule fixture corpus is missing.");
  }
  if (!installedFiles.includes("dist/src/config/diagnostics.js")) {
    throw new Error("Packed structured configuration diagnostics implementation is missing.");
  }
  if (!installedFiles.includes("docs/config-v1-compatibility.md")) {
    throw new Error("Packed config v1 compatibility guide is missing.");
  }
  if (!installedFiles.includes("docs/github-action.md")) {
    throw new Error("Packed validation Action guide is missing.");
  }
  for (const actionFile of [
    "action.yml",
    "action/run-validation.mjs",
    "examples/github-actions/launchrig-validation.yml",
  ]) {
    if (!installedFiles.includes(actionFile)) throw new Error("Packed validation Action is missing " + actionFile + ".");
  }
  const publisherBundleSchema = JSON.parse(
    await readFile(path.join(installedDirectory, "schemas", "launchrig-publisher-bundle.schema.json"), "utf8"),
  );
  const validatePublisherBundle = new Ajv2020({ strict: true }).compile(publisherBundleSchema);
  const legacyRehearsalChecks = [
    "offline-package-install",
    "installed-version-match",
    "installed-help-contract",
    "pilot-timer-start",
    "starter-generation",
    "starter-validation",
    "device-free-preflight-refusal",
  ];
  const v7RehearsalChecks = [
    ...legacyRehearsalChecks,
    "device-free-pilot-policy-lint-refusal",
  ];
  const v8RehearsalChecks = [
    ...v7RehearsalChecks,
    "device-free-session-scope-receipt",
  ];
  const v9RehearsalChecks = [
    ...v8RehearsalChecks,
    "device-free-approved-scope-enforcement",
  ];
  const v10RehearsalChecks = [
    ...v9RehearsalChecks,
    "installed-scope-linked-governance-contract",
  ];
  const v11RehearsalChecks = [
    ...v10RehearsalChecks,
    "device-free-consent-safe-scope-preparation",
  ];
  const v12RehearsalChecks = [
    ...v11RehearsalChecks,
    "device-free-private-recruitment-register-preparation",
  ];
  const v13RehearsalChecks = [
    ...v12RehearsalChecks,
    "device-free-private-prospect-review-confirmation-refusal",
  ];
  const v14RehearsalChecks = [
    ...v13RehearsalChecks,
    "device-free-private-send-decision-preparation-confirmation-refusal",
  ];
  const v15RehearsalChecks = [
    ...v14RehearsalChecks,
    "device-free-private-human-send-decision-confirmation-refusal",
  ];
  const v16RehearsalChecks = [
    ...v15RehearsalChecks,
    "device-free-structured-config-diagnostics",
  ];
  const v17RehearsalChecks = [
    ...v16RehearsalChecks,
    "device-free-runtime-rule-fixtures",
  ];
  const v18RehearsalChecks = [
    ...v17RehearsalChecks,
    "device-free-pilot-rule-fixtures",
  ];
  const v16SchemaBranch = publisherBundleSchema.allOf?.find(
    (entry) =>
      entry.if?.properties?.profile?.const === "phase-3-config-diagnostics-rc-v16",
  );
  const v17SchemaBranch = publisherBundleSchema.allOf?.find(
    (entry) =>
      entry.if?.properties?.profile?.const === "phase-3-runtime-rule-fixtures-rc-v17",
  );
  const v18SchemaBranch = publisherBundleSchema.allOf?.find(
    (entry) =>
      entry.if?.properties?.profile?.const === "phase-3-pilot-rule-fixtures-rc-v18",
  );
  const v16Manifest = createPublisherManifest({
    profile: "phase-3-config-diagnostics-rc-v16",
    launchRigVersion: verifiedBundleManifest.launchRigVersion,
    gitCommit: verifiedBundleManifest.source.gitCommit,
    lockfileSha256: verifiedBundleManifest.source.lockfileSha256,
    nodeEngine: verifiedBundleManifest.package.nodeEngine,
    packageManager: verifiedBundleManifest.package.packageManager,
    packagePath: verifiedBundleManifest.package.path,
    files: verifiedBundleManifest.files,
  });
  const v16WithV17Checks = {
    ...v16Manifest,
    consumerRehearsal: {
      ...v16Manifest.consumerRehearsal,
      checks: v17RehearsalChecks,
    },
  };
  const v17Manifest = createPublisherManifest({
    profile: "phase-3-runtime-rule-fixtures-rc-v17",
    launchRigVersion: verifiedBundleManifest.launchRigVersion,
    gitCommit: verifiedBundleManifest.source.gitCommit,
    lockfileSha256: verifiedBundleManifest.source.lockfileSha256,
    nodeEngine: verifiedBundleManifest.package.nodeEngine,
    packageManager: verifiedBundleManifest.package.packageManager,
    packagePath: verifiedBundleManifest.package.path,
    files: verifiedBundleManifest.files,
  });
  const v17WithV18Checks = {
    ...v17Manifest,
    consumerRehearsal: {
      ...v17Manifest.consumerRehearsal,
      checks: v18RehearsalChecks,
    },
  };
  if (
    publisherBundleSchema.$id !== "https://launchrig.dev/schemas/launchrig-publisher-bundle.schema.json" ||
    publisherBundleSchema.additionalProperties !== false ||
    publisherBundleSchema.properties?.kind?.const !== "launchrig-publisher-bundle" ||
    JSON.stringify(publisherBundleSchema.properties?.profile?.enum) !==
      JSON.stringify([
        "phase-2a-publisher-rc-v1",
        "phase-2b-publisher-rc-v2",
        "phase-2c-publisher-rc-v3",
        "phase-3-foundation-rc-v4",
        "phase-3-config-parity-rc-v5",
        "phase-3-validation-action-rc-v6",
        "phase-2d-publisher-readiness-rc-v7",
        "phase-2e-consent-scope-rc-v8",
        "phase-2f-scope-enforced-pilot-rc-v9",
        "phase-2g-operational-contract-rc-v10",
        "phase-2h-consent-safe-scope-rc-v11",
        "phase-2i-recruitment-register-rc-v12",
        "phase-2l-human-prospect-review-rc-v13",
        "phase-2m-send-decision-preparation-rc-v14",
        "phase-2n-human-send-decision-rc-v15",
        "phase-3-config-diagnostics-rc-v16",
        "phase-3-runtime-rule-fixtures-rc-v17",
        "phase-3-pilot-rule-fixtures-rc-v18",
      ]) ||
    publisherBundleSchema.properties?.grantReady?.const !== false ||
    publisherBundleSchema.properties?.claims?.properties?.externalPublisher?.const !== "not-established" ||
    !validatePublisherBundle(structuredClone(verifiedBundleManifest)) ||
    !validatePublisherBundle(structuredClone(v16Manifest)) ||
    !validatePublisherBundle(structuredClone(v17Manifest)) ||
    validatePublisherBundle(structuredClone(v16WithV17Checks)) !== false ||
    validatePublisherBundle(structuredClone(v17WithV18Checks)) !== false ||
    JSON.stringify(
      publisherBundleSchema.allOf?.[0]?.then?.properties?.consumerRehearsal?.properties?.checks?.const,
    ) !== JSON.stringify(v15RehearsalChecks) ||
    JSON.stringify(
      v16SchemaBranch?.then?.properties?.consumerRehearsal?.properties?.checks?.const,
    ) !== JSON.stringify(v16RehearsalChecks) ||
    JSON.stringify(
      v17SchemaBranch?.then?.properties?.consumerRehearsal?.properties?.checks?.const,
    ) !== JSON.stringify(v17RehearsalChecks) ||
    JSON.stringify(
      v18SchemaBranch?.then?.properties?.consumerRehearsal?.properties?.checks?.const,
    ) !== JSON.stringify(v18RehearsalChecks) ||
    JSON.stringify(publisherBundleSchema.allOf?.[4]?.if?.properties?.profile?.enum) !==
      JSON.stringify([
        "phase-2i-recruitment-register-rc-v12",
        "phase-2l-human-prospect-review-rc-v13",
        "phase-2m-send-decision-preparation-rc-v14",
        "phase-2n-human-send-decision-rc-v15",
        "phase-3-config-diagnostics-rc-v16",
        "phase-3-runtime-rule-fixtures-rc-v17",
        "phase-3-pilot-rule-fixtures-rc-v18",
      ]) ||
    JSON.stringify(
      publisherBundleSchema.allOf?.[1]?.then?.properties?.consumerRehearsal?.properties?.checks?.const,
    ) !== JSON.stringify(v14RehearsalChecks) ||
    JSON.stringify(
      publisherBundleSchema.allOf?.[2]?.then?.properties?.consumerRehearsal?.properties?.checks?.const,
    ) !== JSON.stringify(v13RehearsalChecks) ||
    JSON.stringify(
      publisherBundleSchema.allOf?.[3]?.then?.properties?.consumerRehearsal?.properties?.checks?.const,
    ) !== JSON.stringify(v12RehearsalChecks) ||
    JSON.stringify(
      publisherBundleSchema.allOf?.[4]?.else?.then?.properties?.consumerRehearsal?.properties?.checks
        ?.const,
    ) !== JSON.stringify(v11RehearsalChecks) ||
    JSON.stringify(
      publisherBundleSchema.allOf?.[4]?.else?.else?.then?.properties?.consumerRehearsal?.properties?.checks
        ?.const,
    ) !== JSON.stringify(v10RehearsalChecks) ||
    JSON.stringify(
      publisherBundleSchema.allOf?.[4]?.else?.else?.else?.then?.properties?.consumerRehearsal?.properties
        ?.checks?.const,
    ) !== JSON.stringify(v9RehearsalChecks) ||
    JSON.stringify(
      publisherBundleSchema.allOf?.[4]?.else?.else?.else?.else?.then?.properties?.consumerRehearsal?.properties
        ?.checks?.const,
    ) !== JSON.stringify(v8RehearsalChecks) ||
    JSON.stringify(
      publisherBundleSchema.allOf?.[4]?.else?.else?.else?.else?.else?.then?.properties?.consumerRehearsal?.properties
        ?.checks?.const,
    ) !== JSON.stringify(v7RehearsalChecks) ||
    JSON.stringify(
      publisherBundleSchema.allOf?.[4]?.else?.else?.else?.else?.else?.else?.properties?.consumerRehearsal?.properties
        ?.checks?.const,
    ) !== JSON.stringify(legacyRehearsalChecks) ||
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
  const bindingReceiptSchema = JSON.parse(
    await readFile(
      path.join(installedDirectory, "schemas", "launchrig-pilot-evidence-binding-receipt.schema.json"),
      "utf8",
    ),
  );
  const validateBindingReceipt = new Ajv2020({ strict: true }).compile(bindingReceiptSchema);
  const bindingReceiptLimitations = bindingReceiptSchema.properties?.limitations?.const;
  const sampleBindingReceipt = {
    receiptSchemaVersion: 1,
    kind: "launchrig-pilot-evidence-binding-receipt",
    binding: {
      evidenceId: "123e4567-e89b-42d3-a456-426614174000",
      fileSha256: "a".repeat(64),
      evidenceSha256: "b".repeat(64),
      schemaVersion: 1,
    },
    integrityValid: true,
    internalConsistencyValid: true,
    claimStatus: "self-recorded-unattested",
    technicalStatus: "not-recomputable",
    externalGrantGate: "not-established",
    grantReady: false,
    limitations: bindingReceiptLimitations,
  };
  if (
    bindingReceiptSchema.$id !==
      "https://launchrig.dev/schemas/launchrig-pilot-evidence-binding-receipt.schema.json" ||
    bindingReceiptSchema.additionalProperties !== false ||
    bindingReceiptSchema.properties?.receiptSchemaVersion?.const !== 1 ||
    bindingReceiptSchema.properties?.kind?.const !== "launchrig-pilot-evidence-binding-receipt" ||
    bindingReceiptSchema.properties?.binding?.additionalProperties !== false ||
    bindingReceiptSchema.properties?.grantReady?.const !== false ||
    !validateBindingReceipt(sampleBindingReceipt) ||
    validateBindingReceipt({ ...sampleBindingReceipt, technicalStatus: "qualified-self-recorded" })
  ) {
    throw new Error("Packed binding receipt schema does not preserve the claim-limited contract.");
  }
  const sessionScopeSchema = JSON.parse(
    await readFile(
      path.join(installedDirectory, "schemas", "launchrig-pilot-session-scope.schema.json"),
      "utf8",
    ),
  );
  const sessionScopeReceiptSchema = JSON.parse(
    await readFile(
      path.join(installedDirectory, "schemas", "launchrig-pilot-session-scope-receipt.schema.json"),
      "utf8",
    ),
  );
  const sessionScopeDraftResultSchema = JSON.parse(
    await readFile(
      path.join(installedDirectory, "schemas", "launchrig-pilot-session-scope-draft-result.schema.json"),
      "utf8",
    ),
  );
  const validateSessionScope = new Ajv2020({ strict: true }).compile(sessionScopeSchema);
  const validateSessionScopeReceipt = new Ajv2020({ strict: true }).compile(sessionScopeReceiptSchema);
  const validateSessionScopeDraftResult = new Ajv2020({ strict: true }).compile(sessionScopeDraftResultSchema);
  if (
    sessionScopeSchema.properties?.kind?.const !== "launchrig-pilot-session-scope" ||
    sessionScopeSchema.properties?.policy?.properties?.physicalAndroidRequired?.const !== true ||
    sessionScopeSchema.properties?.policy?.properties?.valuableAssetsAllowed?.const !== false ||
    sessionScopeReceiptSchema.properties?.kind?.const !== "launchrig-pilot-session-scope-receipt" ||
    sessionScopeReceiptSchema.properties?.publisherIdentity?.const !== "not-established" ||
    sessionScopeReceiptSchema.properties?.consentAuthenticity?.const !== "not-established" ||
    sessionScopeReceiptSchema.properties?.externalGrantGate?.const !== "not-established" ||
    sessionScopeReceiptSchema.properties?.grantReady?.const !== false ||
    sessionScopeDraftResultSchema.properties?.kind?.const !== "launchrig-pilot-session-scope-draft-result" ||
    sessionScopeDraftResultSchema.properties?.reviewRequired?.const !== true ||
    sessionScopeDraftResultSchema.properties?.approvalReceiptCreated?.const !== false ||
    sessionScopeDraftResultSchema.properties?.bundleAuthenticity?.const !== "not-established" ||
    sessionScopeDraftResultSchema.properties?.deviceEnvironmentChecked?.const !== false ||
    sessionScopeDraftResultSchema.properties?.grantReady?.const !== false
  ) {
    throw new Error("Packed session scope schemas do not preserve the private claim-limited contract.");
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
  const privateRegisterDraftResultSchema = JSON.parse(
    await readFile(
      path.join(
        installedDirectory,
        "schemas",
        "launchrig-private-cohort-register-draft-result.schema.json",
      ),
      "utf8",
    ),
  );
  const privateAuditSchema = JSON.parse(
    await readFile(path.join(installedDirectory, "schemas", "launchrig-private-cohort-audit.schema.json"), "utf8"),
  );
  const privateProspectReviewSchema = JSON.parse(
    await readFile(
      path.join(installedDirectory, "schemas", "launchrig-private-prospect-review.schema.json"),
      "utf8",
    ),
  );
  const privateProspectReviewResultSchema = JSON.parse(
    await readFile(
      path.join(installedDirectory, "schemas", "launchrig-private-prospect-review-result.schema.json"),
      "utf8",
    ),
  );
  const privateSendDecisionRequestSchema = JSON.parse(
    await readFile(
      path.join(installedDirectory, "schemas", "launchrig-private-send-decision-request.schema.json"),
      "utf8",
    ),
  );
  const privateSendDecisionRequestResultSchema = JSON.parse(
    await readFile(
      path.join(
        installedDirectory,
        "schemas",
        "launchrig-private-send-decision-request-result.schema.json",
      ),
      "utf8",
    ),
  );
  const privateHumanSendDecisionSchema = JSON.parse(
    await readFile(
      path.join(installedDirectory, "schemas", "launchrig-private-human-send-decision.schema.json"),
      "utf8",
    ),
  );
  const privateHumanSendDecisionResultSchema = JSON.parse(
    await readFile(
      path.join(
        installedDirectory,
        "schemas",
        "launchrig-private-human-send-decision-result.schema.json",
      ),
      "utf8",
    ),
  );
  const privateReviewSchemaAjv = new Ajv2020({ strict: true, strictTypes: false });
  privateReviewSchemaAjv.addFormat("date", /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  privateReviewSchemaAjv.compile(privateProspectReviewSchema);
  privateReviewSchemaAjv.compile(privateProspectReviewResultSchema);
  privateReviewSchemaAjv.compile(privateSendDecisionRequestSchema);
  privateReviewSchemaAjv.compile(privateSendDecisionRequestResultSchema);
  privateReviewSchemaAjv.compile(privateHumanSendDecisionSchema);
  privateReviewSchemaAjv.compile(privateHumanSendDecisionResultSchema);
  const coreRuleCatalogSchema = JSON.parse(
    await readFile(path.join(installedDirectory, "schemas", "launchrig-core-rule-catalog.schema.json"), "utf8"),
  );
  const configConformance = JSON.parse(
    await readFile(
      path.join(installedDirectory, "schemas", "fixtures", "launchrig-config-v1.conformance.json"),
      "utf8",
    ),
  );
  const configRuleResultSchema = JSON.parse(
    await readFile(
      path.join(installedDirectory, "schemas", "launchrig-config-validation-result.schema.json"),
      "utf8",
    ),
  );
  const configRuleFixtures = JSON.parse(
    await readFile(
      path.join(
        installedDirectory,
        "schemas",
        "fixtures",
        "launchrig-config-rule-fixtures.v1.json",
      ),
      "utf8",
    ),
  );
  const runtimeRuleFixtureSchema = JSON.parse(
    await readFile(
      path.join(installedDirectory, "schemas", "launchrig-runtime-rule-fixtures.schema.json"),
      "utf8",
    ),
  );
  const runtimeRuleFixtures = JSON.parse(
    await readFile(
      path.join(
        installedDirectory,
        "schemas",
        "fixtures",
        "launchrig-runtime-rule-fixtures.v1.json",
      ),
      "utf8",
    ),
  );
  const pilotRuleFixtureSchema = JSON.parse(
    await readFile(
      path.join(installedDirectory, "schemas", "launchrig-pilot-rule-fixtures.schema.json"),
      "utf8",
    ),
  );
  const pilotRuleFixtures = JSON.parse(
    await readFile(
      path.join(
        installedDirectory,
        "schemas",
        "fixtures",
        "launchrig-pilot-rule-fixtures.v1.json",
      ),
      "utf8",
    ),
  );
  new Ajv2020({ strict: true, strictTypes: false }).compile(configRuleResultSchema);
  const acceptsRuntimeRuleFixtures = new Ajv2020({
    strict: true,
    strictTypes: false,
    strictRequired: false,
  }).compile(runtimeRuleFixtureSchema);
  const acceptsPilotRuleFixtures = new Ajv2020({
    strict: true,
    strictTypes: false,
    strictRequired: false,
  }).compile(pilotRuleFixtureSchema);
  if (
    coreRuleCatalogSchema.$id !== "https://launchrig.dev/schemas/launchrig-core-rule-catalog.schema.json" ||
    coreRuleCatalogSchema.additionalProperties !== false ||
    coreRuleCatalogSchema.properties?.kind?.const !== "launchrig-core-rule-catalog" ||
    coreRuleCatalogSchema.properties?.status?.const !== "pre-award-foundation" ||
    coreRuleCatalogSchema.properties?.ruleCount?.const !== 25 ||
    coreRuleCatalogSchema.properties?.rules?.minItems !== 25 ||
    coreRuleCatalogSchema.properties?.rules?.maxItems !== 25 ||
    coreRuleCatalogSchema.properties?.grantMilestoneComplete?.const !== false
  ) {
    throw new Error("Packed core rule catalog schema does not preserve the pre-award contract.");
  }
  const parityCases = configConformance.cases?.filter((entry) => entry.classification === "parity") ?? [];
  const runtimeExtensionCases =
    configConformance.cases?.filter((entry) => entry.classification === "runtime-extension") ?? [];
  if (
    JSON.stringify(Object.keys(configConformance)) !==
      JSON.stringify([
        "schemaVersion",
        "kind",
        "configVersion",
        "status",
        "schemaPath",
        "parityCaseCount",
        "runtimeExtensionCaseCount",
        "grantMilestoneComplete",
        "base",
        "cases",
        "limitations",
      ]) ||
    configConformance.schemaVersion !== 1 ||
    configConformance.kind !== "launchrig-config-v1-conformance" ||
    configConformance.configVersion !== 1 ||
    configConformance.status !== "pre-award-foundation" ||
    configConformance.schemaPath !== "schemas/launchrig.schema.json" ||
    configConformance.parityCaseCount !== 26 ||
    configConformance.runtimeExtensionCaseCount !== 2 ||
    configConformance.grantMilestoneComplete !== false ||
    configConformance.cases?.length !== 28 ||
    new Set(configConformance.cases?.map((entry) => entry.id)).size !== 28 ||
    parityCases.length !== 26 ||
    parityCases.some((entry) => entry.runtimeValid !== entry.schemaValid) ||
    runtimeExtensionCases.length !== 2 ||
    runtimeExtensionCases.some((entry) => entry.runtimeValid !== false || entry.schemaValid !== true) ||
    configConformance.cases?.some(
      (entry) =>
        JSON.stringify(Object.keys(entry)) !==
        JSON.stringify(["id", "classification", "set", "remove", "runtimeValid", "schemaValid"]),
    )
  ) {
    throw new Error("Packed config v1 corpus does not preserve its executable pre-award contract.");
  }
  if (
    configRuleResultSchema.$id !==
      "https://launchrig.dev/schemas/launchrig-config-validation-result.schema.json" ||
    configRuleResultSchema.additionalProperties !== false ||
    configRuleResultSchema.properties?.kind?.const !== "launchrig-config-validation-result" ||
    configRuleResultSchema.properties?.profile?.const !== "config-rules-v1" ||
    configRuleResultSchema.properties?.grantMilestoneComplete?.const !== false ||
    configRuleFixtures.schemaVersion !== 1 ||
    configRuleFixtures.kind !== "launchrig-config-rule-fixtures" ||
    configRuleFixtures.profile !== "config-rules-v1" ||
    configRuleFixtures.status !== "pre-award-foundation" ||
    configRuleFixtures.caseCount !== 10 ||
    configRuleFixtures.cases?.length !== 10 ||
    new Set(configRuleFixtures.cases?.map((entry) => entry.id)).size !== 10 ||
    JSON.stringify(configRuleFixtures.ruleIds) !==
      JSON.stringify(["LR001", "LR002", "LR003", "LR004", "LR005"]) ||
    configRuleFixtures.grantMilestoneComplete !== false
  ) {
    throw new Error("Packed configuration diagnostics do not preserve the executable pre-award contract.");
  }
  const runtimeExpectations =
    runtimeRuleFixtures.cases?.flatMap((fixture) => fixture.expectations ?? []) ?? [];
  const runtimeRuleIds = Array.from({ length: 13 }, (_, index) =>
    "LR" + String(index + 6).padStart(3, "0"),
  );
  if (
    runtimeRuleFixtureSchema.$id !==
      "https://launchrig.dev/schemas/launchrig-runtime-rule-fixtures.schema.json" ||
    runtimeRuleFixtureSchema.additionalProperties !== false ||
    runtimeRuleFixtures.schemaVersion !== 1 ||
    runtimeRuleFixtures.kind !== "launchrig-runtime-rule-fixtures" ||
    runtimeRuleFixtures.profile !== "runtime-rules-v1" ||
    runtimeRuleFixtures.status !== "pre-award-foundation" ||
    runtimeRuleFixtures.caseCount !== 14 ||
    runtimeRuleFixtures.expectationCount !== 26 ||
    runtimeRuleFixtures.cases?.length !== 14 ||
    runtimeExpectations.length !== 26 ||
    new Set(runtimeRuleFixtures.cases?.map((entry) => entry.id)).size !== 14 ||
    JSON.stringify(runtimeRuleFixtures.ruleIds) !== JSON.stringify(runtimeRuleIds) ||
    runtimeRuleIds.some(
      (ruleId) =>
        !runtimeExpectations.some(
          (expectation) => expectation.ruleId === ruleId && expectation.polarity === "positive",
        ) ||
        !runtimeExpectations.some(
          (expectation) => expectation.ruleId === ruleId && expectation.polarity === "negative",
        ),
    ) ||
    runtimeRuleFixtures.grantMilestoneComplete !== false ||
    !acceptsRuntimeRuleFixtures(structuredClone(runtimeRuleFixtures))
  ) {
    throw new Error("Packed runtime rule fixtures do not preserve the executable pre-award contract.");
  }
  const pilotExpectations =
    pilotRuleFixtures.cases?.flatMap((fixture) => fixture.expectations ?? []) ?? [];
  const pilotRuleIds = Array.from({ length: 7 }, (_, index) =>
    "LR" + String(index + 19).padStart(3, "0"),
  );
  const pilotCatalogChecks = {
    LR019: "pilot.state",
    LR020: "pilot.project",
    LR021: "pilot.wallet",
    LR022: "pilot.device-policy",
    LR023: "pilot.flows",
    LR024: "pilot.mwa-coverage",
    LR025: "pilot.environment",
  };
  if (
    pilotRuleFixtureSchema.$id !==
      "https://launchrig.dev/schemas/launchrig-pilot-rule-fixtures.schema.json" ||
    pilotRuleFixtureSchema.additionalProperties !== false ||
    pilotRuleFixtures.schemaVersion !== 1 ||
    pilotRuleFixtures.kind !== "launchrig-pilot-rule-fixtures" ||
    pilotRuleFixtures.profile !== "pilot-rules-v1" ||
    pilotRuleFixtures.status !== "pre-award-foundation" ||
    pilotRuleFixtures.caseCount !== 8 ||
    pilotRuleFixtures.expectationCount !== 56 ||
    pilotRuleFixtures.cases?.length !== 8 ||
    pilotExpectations.length !== 56 ||
    new Set(pilotRuleFixtures.cases?.map((entry) => entry.id)).size !== 8 ||
    JSON.stringify(pilotRuleFixtures.ruleIds) !== JSON.stringify(pilotRuleIds) ||
    pilotRuleFixtures.cases?.some(
      (fixture) =>
        fixture.expectations?.length !== 7 ||
        new Set(fixture.expectations?.map((expectation) => expectation.checkId)).size !== 7,
    ) ||
    pilotExpectations.some(
      (expectation) => pilotCatalogChecks[expectation.ruleId] !== expectation.checkId,
    ) ||
    pilotRuleIds.some(
      (ruleId) =>
        !pilotExpectations.some(
          (expectation) =>
            expectation.ruleId === ruleId && expectation.classification === "positive",
        ) ||
        !pilotExpectations.some(
          (expectation) =>
            expectation.ruleId === ruleId && expectation.classification === "negative",
        ),
    ) ||
    !pilotExpectations.some(
      (expectation) =>
        expectation.ruleId === "LR025" && expectation.classification === "conditional",
    ) ||
    pilotRuleFixtures.grantMilestoneComplete !== false ||
    !acceptsPilotRuleFixtures(structuredClone(pilotRuleFixtures))
  ) {
    throw new Error("Packed pilot rule fixtures do not preserve the executable pre-award contract.");
  }
  if (
    privateRegisterSchema.$id !==
      "https://launchrig.dev/schemas/launchrig-private-cohort-register.schema.json" ||
    privateRegisterSchema.additionalProperties !== false ||
    privateRegisterSchema.properties?.privacyProfile?.const !== "opaque-refs-digests-dates-v1" ||
    privateRegisterSchema.properties?.candidates?.maxItems !== 25 ||
    privateRegisterSchema.$defs?.candidate?.additionalProperties !== false ||
    privateRegisterSchema.$defs?.evidenceBinding?.properties?.schemaVersion?.enum?.join(",") !== "1,2,3"
  ) {
    throw new Error("Packed private cohort register schema does not preserve the privacy contract.");
  }
  if (
    privateRegisterDraftResultSchema.$id !==
      "https://launchrig.dev/schemas/launchrig-private-cohort-register-draft-result.schema.json" ||
    privateRegisterDraftResultSchema.additionalProperties !== false ||
    privateRegisterDraftResultSchema.properties?.kind?.const !==
      "launchrig-private-cohort-register-draft-result" ||
    privateRegisterDraftResultSchema.properties?.claimStatus?.const !==
      "operator-prepared-unattested" ||
    privateRegisterDraftResultSchema.properties?.candidateRecords?.const !== 0 ||
    privateRegisterDraftResultSchema.properties?.interestRecorded?.const !== 0 ||
    privateRegisterDraftResultSchema.properties?.projectModificationAuthorized?.const !== false ||
    privateRegisterDraftResultSchema.properties?.phoneAccessAuthorized?.const !== false ||
    privateRegisterDraftResultSchema.properties?.candidatePool?.const !== "not-established" ||
    privateRegisterDraftResultSchema.properties?.externalGrantGate?.const !== "not-established" ||
    privateRegisterDraftResultSchema.properties?.grantReady?.const !== false
  ) {
    throw new Error("Packed private cohort register draft result schema does not preserve the claim limit.");
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
  if (
    privateProspectReviewSchema.$id !==
      "https://launchrig.dev/schemas/launchrig-private-prospect-review.schema.json" ||
    privateProspectReviewSchema.additionalProperties !== false ||
    privateProspectReviewSchema.properties?.humanReviewConfirmed?.const !== true ||
    privateProspectReviewSchema.properties?.humanReviewerAuthenticated?.const !== false ||
    privateProspectReviewSchema.properties?.contact?.const !== "not-contacted" ||
    privateProspectReviewSchema.properties?.sendAuthorization?.const !== "not-authorized" ||
    privateProspectReviewSchema.properties?.lifecycle?.const !== "screening" ||
    privateProspectReviewSchema.properties?.candidateCreated?.const !== false ||
    privateProspectReviewSchema.properties?.projectModificationAuthorized?.const !== false ||
    privateProspectReviewSchema.properties?.phoneAccessAuthorized?.const !== false ||
    privateProspectReviewSchema.properties?.externalGrantGate?.const !== "not-established" ||
    privateProspectReviewSchema.properties?.grantReady?.const !== false ||
    privateProspectReviewSchema.$defs?.draftLabel?.enum?.includes("operator-prepared-unreviewed")
  ) {
    throw new Error("Packed private prospect review schema does not preserve the human-review claim limit.");
  }
  if (
    privateProspectReviewResultSchema.$id !==
      "https://launchrig.dev/schemas/launchrig-private-prospect-review-result.schema.json" ||
    privateProspectReviewResultSchema.additionalProperties !== false ||
    privateProspectReviewResultSchema.properties?.humanReviewConfirmed?.const !== true ||
    privateProspectReviewResultSchema.properties?.humanReviewerAuthenticated?.const !== false ||
    privateProspectReviewResultSchema.properties?.contact?.const !== "not-contacted" ||
    privateProspectReviewResultSchema.properties?.sendAuthorization?.const !== "not-authorized" ||
    privateProspectReviewResultSchema.properties?.phoneAccessAuthorized?.const !== false ||
    privateProspectReviewResultSchema.properties?.externalGrantGate?.const !== "not-established" ||
    privateProspectReviewResultSchema.properties?.grantReady?.const !== false
  ) {
    throw new Error("Packed private prospect review result schema does not preserve the claim limit.");
  }
  for (const [label, schema, expectedId, expectedKind] of [
    [
      "request",
      privateSendDecisionRequestSchema,
      "https://launchrig.dev/schemas/launchrig-private-send-decision-request.schema.json",
      "launchrig-private-send-decision-request",
    ],
    [
      "request result",
      privateSendDecisionRequestResultSchema,
      "https://launchrig.dev/schemas/launchrig-private-send-decision-request-result.schema.json",
      "launchrig-private-send-decision-request-result",
    ],
  ]) {
    if (
      schema.$id !== expectedId ||
      schema.additionalProperties !== false ||
      schema.properties?.kind?.const !== expectedKind ||
      schema.properties?.profile?.const !== "phase-2m-send-decision-preparation-v1" ||
      schema.properties?.claimStatus?.const !== "operator-prepared-unattested" ||
      schema.properties?.reviewSetCompleteness?.const !== "operator-asserted-unattested" ||
      schema.properties?.conflictStatus?.const !== "none-detected-in-operator-supplied-set" ||
      schema.properties?.latestStatus?.const !== "not-established" ||
      schema.properties?.preparationStatus?.const !== "awaiting-exact-human-send-decision" ||
      schema.properties?.humanRelatedReviewSetConfirmed?.const !== true ||
      schema.properties?.humanSendDecisionRecorded?.const !== false ||
      schema.properties?.humanAuthorizerAuthenticated?.const !== false ||
      schema.properties?.sourceRecheck?.const !== "not-recorded" ||
      schema.properties?.routeRecheck?.const !== "not-recorded" ||
      schema.properties?.relationshipDisclosureRecheck?.const !== "not-recorded" ||
      schema.properties?.compensationDisclosureRecheck?.const !== "not-recorded" ||
      schema.properties?.safetyRecheck?.const !== "not-recorded" ||
      schema.properties?.contact?.const !== "not-contacted" ||
      schema.properties?.sendAuthorization?.const !== "not-authorized" ||
      schema.properties?.messageDispatched?.const !== false ||
      schema.properties?.lifecycle?.const !== "screening" ||
      schema.properties?.candidateCreated?.const !== false ||
      schema.properties?.interestRecorded?.const !== false ||
      schema.properties?.projectModificationAuthorized?.const !== false ||
      schema.properties?.phoneAccessAuthorized?.const !== false ||
      schema.properties?.pilotStateChecked?.const !== false ||
      schema.properties?.deviceEnvironmentChecked?.const !== false ||
      schema.properties?.publisherIdentity?.const !== "not-established" ||
      schema.properties?.publisherAuthority?.const !== "not-established" ||
      schema.properties?.publisherConsent?.const !== "not-established" ||
      schema.properties?.publisherIndependence?.const !== "not-established" ||
      schema.properties?.externalGrantGate?.const !== "not-established" ||
      schema.properties?.grantReady?.const !== false
    ) {
      throw new Error("Packed private send decision " + label + " schema does not preserve the claim limit.");
    }
  }
  if (
    privateSendDecisionRequestSchema.properties?.privacyProfile?.const !==
      "opaque-operator-digests-dates-v1" ||
    privateSendDecisionRequestSchema.properties?.reviewSet?.minItems !== 1 ||
    privateSendDecisionRequestSchema.properties?.reviewSet?.maxItems !== 1 ||
    privateSendDecisionRequestResultSchema.properties?.status?.const !== "created" ||
    privateSendDecisionRequestResultSchema.properties?.reviewSetCount?.const !== 1
  ) {
    throw new Error("Packed private send decision schemas do not preserve the bounded review-set contract.");
  }
  for (const [label, schema, expectedId, expectedKind] of [
    [
      "record",
      privateHumanSendDecisionSchema,
      "https://launchrig.dev/schemas/launchrig-private-human-send-decision.schema.json",
      "launchrig-private-human-send-decision",
    ],
    [
      "result",
      privateHumanSendDecisionResultSchema,
      "https://launchrig.dev/schemas/launchrig-private-human-send-decision-result.schema.json",
      "launchrig-private-human-send-decision-result",
    ],
  ]) {
    if (
      schema.$id !== expectedId ||
      schema.additionalProperties !== false ||
      schema.properties?.kind?.const !== expectedKind ||
      schema.properties?.profile?.const !== "phase-2n-human-send-decision-v1" ||
      schema.properties?.claimStatus?.const !== "human-operator-recorded-unattested" ||
      schema.properties?.humanSendDecisionConfirmed?.const !== true ||
      schema.properties?.humanNoAdditionalRelatedReviewConfirmed?.const !== true ||
      schema.properties?.humanAuthorizerAuthenticated?.const !== false ||
      schema.properties?.reviewSetCompleteness?.const !== "operator-asserted-unattested" ||
      schema.properties?.conflictStatus?.const !== "none-detected-in-operator-supplied-set" ||
      schema.properties?.latestStatus?.const !== "not-established" ||
      schema.properties?.reviewSetCount?.const !== 1 ||
      schema.properties?.contact?.const !== "not-contacted" ||
      schema.properties?.messageDispatched?.const !== false ||
      schema.properties?.lifecycle?.const !== "screening" ||
      schema.properties?.candidateCreated?.const !== false ||
      schema.properties?.interestRecorded?.const !== false ||
      schema.properties?.projectModificationAuthorized?.const !== false ||
      schema.properties?.phoneAccessAuthorized?.const !== false ||
      schema.properties?.pilotStateChecked?.const !== false ||
      schema.properties?.deviceEnvironmentChecked?.const !== false ||
      schema.properties?.publisherIdentity?.const !== "not-established" ||
      schema.properties?.publisherAuthority?.const !== "not-established" ||
      schema.properties?.publisherConsent?.const !== "not-established" ||
      schema.properties?.publisherIndependence?.const !== "not-established" ||
      schema.properties?.externalGrantGate?.const !== "not-established" ||
      schema.properties?.grantReady?.const !== false ||
      JSON.stringify(schema.properties?.decision?.enum) !==
        JSON.stringify(["authorize-exact-reviewed-draft", "require-revision", "defer", "do-not-send"]) ||
      JSON.stringify(schema.properties?.sendAuthorization?.enum) !==
        JSON.stringify(["authorized-for-one-exact-manual-fit-check-send", "not-authorized"]) ||
      JSON.stringify(schema.properties?.authorizationScope?.enum) !==
        JSON.stringify(["one-manual-send-of-exact-reviewed-draft", "none"])
    ) {
      throw new Error("Packed private human send decision " + label + " schema does not preserve the claim limit.");
    }
  }
  if (
    privateHumanSendDecisionSchema.properties?.privacyProfile?.const !==
      "opaque-authorizer-digests-decision-v1" ||
    privateHumanSendDecisionResultSchema.properties?.status?.const !== "created"
  ) {
    throw new Error("Packed private human send decision schemas do not preserve the private result contract.");
  }
  const expectedDocuments = [
    "docs/cohort-audit.md",
    "docs/cohort-verification.md",
    "docs/config-v1-compatibility.md",
    "docs/github-action.md",
    "docs/phase-1.md",
    "docs/phase-2.md",
    "docs/phase-3-foundation.md",
    "docs/physical-device.md",
    "docs/publisher-bundle-readme.md",
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
  ];
  for (const document of expectedDocuments) {
    if (!installedFiles.includes(document)) throw new Error("Packed documentation is missing " + document + ".");
  }
  const expectedTemplates = [
    "templates/pilot-consent.md",
    "templates/pilot-notes.md",
    "templates/defect-evidence.md",
    "templates/publisher-fit-check.md",
    "templates/publisher-intake.md",
    "templates/sharing-review.md",
  ];
  for (const template of expectedTemplates) {
    if (!installedFiles.includes(template)) throw new Error("Packed template is missing " + template + ".");
  }
  const operationalTemplateContracts = [
    {
      file: "templates/pilot-consent.md",
      scopeCommandsRequired: true,
    },
    {
      file: "templates/pilot-notes.md",
      scopeCommandsRequired: true,
    },
    {
      file: "templates/publisher-intake.md",
      scopeCommandsRequired: true,
    },
    {
      file: "templates/sharing-review.md",
      scopeCommandsRequired: false,
    },
  ];
  for (const contract of operationalTemplateContracts) {
    const source = await readFile(path.join(installedDirectory, ...contract.file.split("/")), "utf8");
    const commonContractPresent =
      /evidence v3/i.test(source) &&
      /stable[\s\S]{0,80}scope(?:-| )digest[\s\S]{0,100}link/i.test(source) &&
      /evidence v1 and v2[\s\S]{0,120}historical[\s\S]{0,180}cannot satisfy[\s\S]{0,100}(?:private )?scope-linked governance/i.test(
        source,
      );
    const scopeCommandContractPresent =
      !contract.scopeCommandsRequired ||
      (/--scope FILE/.test(source) && /pilot check/.test(source) && /pilot run/.test(source));
    const staleV2InstructionPresent =
      /the evidence v2 JSON passes/i.test(source) ||
      /only an approved, verified evidence v2 JSON is eligible/i.test(source) ||
      /public evidence v2 includes/i.test(source);
    if (!commonContractPresent || !scopeCommandContractPresent || staleV2InstructionPresent) {
      throw new Error("Packed operational template does not preserve the evidence v3 handoff contract: " + contract.file);
    }
  }
  const expectedSchemas = [
    "schemas/fixtures/launchrig-config-rule-fixtures.v1.json",
    "schemas/fixtures/launchrig-config-v1.conformance.json",
    "schemas/fixtures/launchrig-pilot-rule-fixtures.v1.json",
    "schemas/fixtures/launchrig-runtime-rule-fixtures.v1.json",
    "schemas/launchrig-cohort-verification.schema.json",
    "schemas/launchrig-config-validation-result.schema.json",
    "schemas/launchrig-core-rule-catalog.schema.json",
    "schemas/launchrig-pilot-evidence-v1.schema.json",
    "schemas/launchrig-pilot-evidence-v2.schema.json",
    "schemas/launchrig-pilot-evidence-v3.schema.json",
    "schemas/launchrig-pilot-evidence-binding-receipt.schema.json",
    "schemas/launchrig-pilot-evidence.schema.json",
    "schemas/launchrig-pilot-session-scope-receipt.schema.json",
    "schemas/launchrig-pilot-session-scope-draft-result.schema.json",
    "schemas/launchrig-pilot-session-scope.schema.json",
    "schemas/launchrig-pilot-rule-fixtures.schema.json",
    "schemas/launchrig-private-cohort-audit.schema.json",
    "schemas/launchrig-private-cohort-register-draft-result.schema.json",
    "schemas/launchrig-private-cohort-register.schema.json",
    "schemas/launchrig-private-prospect-review-result.schema.json",
    "schemas/launchrig-private-prospect-review.schema.json",
    "schemas/launchrig-private-human-send-decision-result.schema.json",
    "schemas/launchrig-private-human-send-decision.schema.json",
    "schemas/launchrig-private-send-decision-request-result.schema.json",
    "schemas/launchrig-private-send-decision-request.schema.json",
    "schemas/launchrig-runtime-rule-fixtures.schema.json",
    "schemas/launchrig-publisher-bundle.schema.json",
    "schemas/launchrig.schema.json",
  ];
  const expectedActionFiles = [
    "action.yml",
    "action/run-validation.mjs",
    "examples/github-actions/launchrig-validation.yml",
  ];
  const expectedRuntimeFiles = [
    "scripts/runtime-contract.mjs",
    "scripts/verify-pilot-bundle.mjs",
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
  const actualActionFiles = installedFiles
    .filter((file) => file === "action.yml" || file.startsWith("action/") || file.startsWith("examples/"))
    .sort();
  if (JSON.stringify(actualActionFiles) !== JSON.stringify([...expectedActionFiles].sort())) {
    throw new Error("Packed Action inventory does not match the release allowlist.");
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
    file.startsWith("templates/") ||
    expectedRuntimeFiles.includes(file) ||
    expectedActionFiles.includes(file);
  const unexpectedPackageFile = installedFiles.find((file) => !allowedPackageFile(file));
  if (unexpectedPackageFile) throw new Error("Packed archive contains an unexpected file: " + unexpectedPackageFile);
  const forbiddenPackageFile = installedFiles.find(
    (file) =>
      file.startsWith(".launchrig/") ||
      file.startsWith(".git/") ||
      file.startsWith("apps/") ||
      file.startsWith("fixtures/") ||
      (file.startsWith("scripts/") && !expectedRuntimeFiles.includes(file)) ||
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
  if (!help.stdout.includes("launchrig pilot binding FILE")) {
    throw new Error("Installed CLI help is missing the public evidence binding receipt.");
  }
  if (!help.stdout.includes("launchrig pilot scope FILE")) {
    throw new Error("Installed CLI help is missing the private session scope receipt.");
  }
  if (!help.stdout.includes("launchrig pilot prepare-scope")) {
    throw new Error("Installed CLI help is missing consent-safe private scope preparation.");
  }
  if (!help.stdout.includes("launchrig pilot lint")) {
    throw new Error("Installed CLI help is missing the device-free pilot policy lint.");
  }
  if (!help.stdout.includes("launchrig pilot check --pilot ID --scope FILE")) {
    throw new Error("Installed CLI help is missing the publisher pilot preflight.");
  }
  if (!help.stdout.includes("launchrig pilot run --pilot ID --scope FILE")) {
    throw new Error("Installed CLI help is missing the scope-enforced publisher pilot run.");
  }
  if (!help.stdout.includes("launchrig cohort verify FILE...")) {
    throw new Error("Installed CLI help is missing the Phase 2B cohort verifier.");
  }
  if (!help.stdout.includes("launchrig cohort audit REGISTER [EVIDENCE...]")) {
    throw new Error("Installed CLI help is missing the Phase 2C private cohort audit.");
  }
  if (!help.stdout.includes("launchrig cohort prepare-register --output FILE")) {
    throw new Error("Installed CLI help is missing the Phase 2I private register preparation command.");
  }
  if (!help.stdout.includes("launchrig cohort record-prospect-review --prospect FILE")) {
    throw new Error("Installed CLI help is missing the Phase 2L private prospect review command.");
  }
  if (
    !help.stdout.includes(
      "launchrig cohort prepare-send-decision --review FILE --expected-review-sha256 HASH --prospect FILE --expected-prospect-sha256 HASH --draft FILE --expected-draft-sha256 HASH [--related-review FILE --expected-related-review-sha256 HASH ...] --operator-ref REF --prepared-on YYYY-MM-DD --confirm-related-review-set-complete --output FILE [--json]",
    )
  ) {
    throw new Error("Installed CLI help is missing the Phase 2M private send decision preparation command.");
  }
  if (
    !help.stdout.includes(
      "launchrig cohort record-send-decision --request FILE --expected-request-sha256 HASH --review FILE --expected-review-sha256 HASH --prospect FILE --expected-prospect-sha256 HASH --draft FILE --expected-draft-sha256 HASH --authorizer-ref REF --decided-on YYYY-MM-DD --decision DECISION --reason-code CODE --source-recheck STATUS --route-recheck STATUS --relationship-disclosure-recheck STATUS --compensation-disclosure-recheck STATUS --safety-recheck STATUS [--authorization-expires-on YYYY-MM-DD] --confirm-human-send-decision --output FILE [--json]",
    )
  ) {
    throw new Error("Installed CLI help is missing the Phase 2N private human send decision command.");
  }
  if (!help.stdout.includes("launchrig rules [--json]")) {
    throw new Error("Installed CLI help is missing the core rule catalog.");
  }

  const coreRuleCatalog = JSON.parse(
    (await run(executable, ["rules", "--json"], { cwd: installDirectory })).stdout,
  );
  const { catalogSha256, ...coreRuleCatalogCore } = coreRuleCatalog;
  if (
    coreRuleCatalog.kind !== "launchrig-core-rule-catalog" ||
    coreRuleCatalog.status !== "pre-award-foundation" ||
    coreRuleCatalog.ruleCount !== 25 ||
    coreRuleCatalog.rules?.length !== 25 ||
    new Set(coreRuleCatalog.rules?.map((rule) => rule.ruleId)).size !== 25 ||
    coreRuleCatalog.grantMilestoneComplete !== false ||
    catalogSha256 !== sha256Value(coreRuleCatalogCore)
  ) {
    throw new Error("Installed core rule catalog does not preserve its deterministic pre-award contract.");
  }

  const preparedRegisterPath = path.join(temporaryDirectory, "prepared-private-cohort-register.json");
  const preparedRegisterResult = JSON.parse(
    (
      await run(
        executable,
        ["cohort", "prepare-register", "--output", preparedRegisterPath, "--json"],
        { cwd: installDirectory },
      )
    ).stdout,
  );
  const preparedRegisterBytes = await readFile(preparedRegisterPath);
  const preparedRegister = JSON.parse(preparedRegisterBytes.toString("utf8"));
  const preparedRegisterMetadata = await lstat(preparedRegisterPath);
  const preparedRegisterValidator = new Ajv2020({ strict: true }).compile(
    privateRegisterDraftResultSchema,
  );
  if (
    !preparedRegisterValidator(preparedRegisterResult) ||
    preparedRegisterResult.fileSha256 !== createHash("sha256").update(preparedRegisterBytes).digest("hex") ||
    preparedRegisterResult.candidateRecords !== 0 ||
    preparedRegisterResult.interestRecorded !== 0 ||
    preparedRegisterResult.projectModificationAuthorized !== false ||
    preparedRegisterResult.phoneAccessAuthorized !== false ||
    preparedRegisterResult.deviceEnvironmentChecked !== false ||
    preparedRegisterResult.candidatePool !== "not-established" ||
    preparedRegisterResult.externalGrantGate !== "not-established" ||
    preparedRegisterResult.grantReady !== false ||
    preparedRegister.candidates?.length !== 0 ||
    preparedRegister.defects?.length !== 0 ||
    preparedRegister.integritySha256 !== null ||
    !preparedRegisterMetadata.isFile() ||
    preparedRegisterMetadata.nlink !== 1 ||
    (process.platform !== "win32" && (preparedRegisterMetadata.mode & 0o777) !== 0o600) ||
    JSON.stringify(preparedRegisterResult).includes(preparedRegisterPath) ||
    JSON.stringify(preparedRegisterResult).includes("urn:launchrig:") ||
    JSON.stringify(preparedRegisterResult).includes("Android Device Ready") ||
    JSON.stringify(preparedRegisterResult).includes("Android/MWA Ready")
  ) {
    throw new Error("Installed private register preparation did not preserve its path-free claim limit.");
  }
  const preparedRegisterAudit = JSON.parse(
    (await run(executable, ["cohort", "audit", preparedRegisterPath, "--json"], { cwd: installDirectory })).stdout,
  );
  if (
    preparedRegisterAudit.summary?.candidateRecords !== 0 ||
    preparedRegisterAudit.summary?.interestRecorded !== 0 ||
    preparedRegisterAudit.summary?.recordedGovernanceAndTechnicalThresholdMet !== false ||
    preparedRegisterAudit.externalGrantGate?.status !== "not-established" ||
    preparedRegisterAudit.grantReady !== false
  ) {
    throw new Error("Installed prepared register audit elevated an external claim.");
  }

  const prospectReviewInputPath = path.join(temporaryDirectory, "review-prospect-input.md");
  const draftReviewInputPath = path.join(temporaryDirectory, "review-draft-input.md");
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
  let prospectReviewRefusal = "";
  try {
    await run(
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
        smokeRef("reviewer", 950),
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
      { cwd: installDirectory },
    );
  } catch (error) {
    prospectReviewRefusal = error instanceof Error ? error.message : String(error);
  }
  const reviewOutputExists = await lstat(privateProspectReviewPath).then(
    () => true,
    () => false,
  );
  if (
    !prospectReviewRefusal.includes("Explicit human review confirmation is required") ||
    reviewOutputExists ||
    prospectReviewRefusal.includes("Android Device Ready") ||
    prospectReviewRefusal.includes("Android/MWA Ready")
  ) {
    throw new Error("Installed private prospect review did not refuse missing human confirmation safely.");
  }

  const sendDecisionOutputPath = path.join(temporaryDirectory, "private-send-decision-request.json");
  let sendDecisionRefusal = "";
  try {
    await run(
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
        smokeRef("reviewer", 951),
        "--prepared-on",
        new Date().toISOString().slice(0, 10),
        "--output",
        sendDecisionOutputPath,
        "--json",
      ],
      { cwd: installDirectory },
    );
  } catch (error) {
    sendDecisionRefusal = error instanceof Error ? error.message : String(error);
  }
  const sendDecisionOutputExists = await lstat(sendDecisionOutputPath).then(
    () => true,
    () => false,
  );
  if (
    !sendDecisionRefusal.includes("Explicit related review set confirmation is required") ||
    sendDecisionOutputExists ||
    sendDecisionRefusal.includes("Android Device Ready") ||
    sendDecisionRefusal.includes("Android/MWA Ready")
  ) {
    throw new Error("Installed send decision preparation did not refuse before reading private inputs.");
  }

  const humanSendDecisionOutputPath = path.join(
    temporaryDirectory,
    "private-human-send-decision.json",
  );
  let humanSendDecisionRefusal = "";
  try {
    await run(
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
        smokeRef("reviewer", 952),
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
      { cwd: installDirectory },
    );
  } catch (error) {
    humanSendDecisionRefusal = error instanceof Error ? error.message : String(error);
  }
  const humanSendDecisionOutputExists = await lstat(humanSendDecisionOutputPath).then(
    () => true,
    () => false,
  );
  if (
    !humanSendDecisionRefusal.includes("Explicit human send decision confirmation is required") ||
    humanSendDecisionOutputExists ||
    humanSendDecisionRefusal.includes("Android Device Ready") ||
    humanSendDecisionRefusal.includes("Android/MWA Ready")
  ) {
    throw new Error("Installed human send decision did not refuse before reading private inputs.");
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
  const actionOutputPath = path.join(temporaryDirectory, "github-action-output.txt");
  await writeFile(actionOutputPath, "", { encoding: "utf8", mode: 0o600 });
  const actionRunner = path.join(installedDirectory, "action", "run-validation.mjs");
  const actionRun = await run(process.execPath, [actionRunner], {
    cwd: publisherDirectory,
    env: {
      ...process.env,
      GITHUB_ACTION_PATH: installedDirectory,
      GITHUB_OUTPUT: actionOutputPath,
      GITHUB_WORKSPACE: publisherDirectory,
      LAUNCHRIG_ACTION_CONFIG: "launchrig.yml",
      LAUNCHRIG_ACTION_OUTPUT: ".launchrig/package-smoke-validation.json",
      LAUNCHRIG_ACTION_WORKING_DIRECTORY: ".",
    },
  });
  if (!actionRun.stdout.includes("LaunchRig configuration validation passed.")) {
    throw new Error("Installed validation Action did not report a passing starter config.");
  }
  const actionResult = JSON.parse(
    await readFile(path.join(publisherDirectory, ".launchrig", "package-smoke-validation.json"), "utf8"),
  );
  if (
    actionResult.schemaVersion !== 1 ||
    actionResult.kind !== "launchrig-validation-action-result" ||
    actionResult.status !== "passed" ||
    actionResult.valid !== true ||
    actionResult.scenarioCount !== 0 ||
    actionResult.failureCode !== null
  ) {
    throw new Error("Installed validation Action result does not preserve its normalized contract.");
  }
  if (
    (await readFile(actionOutputPath, "utf8")) !==
    "valid=true\nscenario-count=0\nresult-file=.launchrig/package-smoke-validation.json\n"
  ) {
    throw new Error("Installed validation Action outputs do not preserve their safe contract.");
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
    !preflightFailure.message.includes("pilot check requires --scope FILE")
  ) {
    throw new Error("Installed pilot preflight did not require an approved private scope.");
  }
  let lintFailure;
  try {
    await run(executable, ["pilot", "lint", "--config", "launchrig.yml", "--json"], {
      cwd: publisherDirectory,
    });
  } catch (error) {
    lintFailure = error;
  }
  if (
    !(lintFailure instanceof Error) ||
    !lintFailure.message.includes('"kind": "launchrig-pilot-policy-lint"') ||
    !lintFailure.message.includes('"staticPolicyValid": false') ||
    !lintFailure.message.includes("Required MWA coverage is missing") ||
    lintFailure.message.includes("Android Device Ready") ||
    lintFailure.message.includes("Android/MWA Ready")
  ) {
    throw new Error("Installed pilot lint did not safely reject the incomplete starter.");
  }
  const ignoreSource = await readFile(path.join(publisherDirectory, ".gitignore"), "utf8");
  if (!ignoreSource.split(/\r?\n/).includes(".launchrig/")) {
    throw new Error("Installed init did not ignore private LaunchRig state.");
  }
  for (const flow of ["mwa-authorize", "mwa-siws", "mwa-sign-message", "mwa-reject"]) {
    await readFile(path.join(publisherDirectory, "launchrig-flows", flow + ".example.yaml"), "utf8");
  }
  const promotedScenarios = [
    ["authorize", "mwa-authorize", "Authorize"],
    ["siws", "mwa-siws", "Sign in with Solana"],
    ["sign-message", "mwa-sign-message", "Sign message"],
    ["reject", "mwa-reject", "Reject and recover"],
  ];
  for (const [id] of promotedScenarios) {
    await writeFile(
      path.join(publisherDirectory, "launchrig-flows", id + ".yaml"),
      [
        "appId: com.example.packagesmoke",
        "---",
        "- launchApp:",
        "    clearState: false",
        "- assertVisible:",
        "    id: package-smoke-" + id + "-ready",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  const appApkPath = path.join(publisherDirectory, "package-smoke-app.apk");
  await writeFile(appApkPath, "package smoke app artifact v1\n", { flag: "wx", mode: 0o600 });
  const starterSource = await readFile(path.join(publisherDirectory, "launchrig.yml"), "utf8");
  const promotedConfig = starterSource
    .replace("  # apk: ./build/app-devnet.apk", "  apk: ./package-smoke-app.apk")
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
  await writeFile(path.join(publisherDirectory, "launchrig.yml"), promotedConfig, "utf8");
  const policyLint = JSON.parse(
    (
      await run(executable, ["pilot", "lint", "--config", "launchrig.yml", "--json"], {
        cwd: publisherDirectory,
      })
    ).stdout,
  );
  if (
    policyLint.kind !== "launchrig-pilot-policy-lint" ||
    policyLint.status !== "passed" ||
    policyLint.staticPolicyValid !== true ||
    policyLint.pilotStateChecked !== false ||
    policyLint.deviceEnvironmentChecked !== false ||
    policyLint.checks?.length !== 5 ||
    policyLint.checks.some((check) => check.status !== "pass") ||
    policyLint.externalGrantGate?.status !== "not-established" ||
    policyLint.grantReady !== false ||
    JSON.stringify(policyLint).includes("Android Device Ready") ||
    JSON.stringify(policyLint).includes("Android/MWA Ready")
  ) {
    throw new Error("Installed pilot lint did not accept the promoted static policy contract.");
  }

  const sessionScopePath = path.join(publisherDirectory, "private-session-scope.json");
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
          verifiedBundleDirectory,
          "--expires-on",
          "2099-12-31",
          "--deletion-method",
          "publisher-managed",
          "--output",
          sessionScopePath,
          "--json",
        ],
        { cwd: publisherDirectory },
      )
    ).stdout,
  );
  const scopeMetadata = await lstat(sessionScopePath);
  if (
    !validateSessionScopeDraftResult(preparation) ||
    preparation.status !== "created" ||
    preparation.binding?.bundleId !== verifiedBundleManifest.bundleId ||
    preparation.binding?.packageSha256 !== verifiedBundleManifest.package.sha256 ||
    preparation.bundleVerification?.status !== "passed" ||
    preparation.policyValid !== true ||
    preparation.reviewRequired !== true ||
    preparation.approvalReceiptCreated !== false ||
    preparation.pilotStateChecked !== false ||
    preparation.deviceEnvironmentChecked !== false ||
    preparation.publisherIdentity !== "not-established" ||
    preparation.consentAuthenticity !== "not-established" ||
    preparation.bundleAuthenticity !== "not-established" ||
    preparation.externalGrantGate !== "not-established" ||
    preparation.grantReady !== false ||
    !scopeMetadata.isFile() ||
    scopeMetadata.nlink !== 1 ||
    (process.platform !== "win32" && (scopeMetadata.mode & 0o777) !== 0o600) ||
    JSON.stringify(preparation).includes(sessionScopePath) ||
    JSON.stringify(preparation).includes("urn:launchrig:") ||
    JSON.stringify(preparation).includes("Android Device Ready") ||
    JSON.stringify(preparation).includes("Android/MWA Ready")
  ) {
    throw new Error("Installed pilot scope preparation did not preserve its private device-free contract.");
  }
  const sessionScopeBytes = await readFile(sessionScopePath);
  const sessionScopeInput = JSON.parse(sessionScopeBytes.toString("utf8"));
  if (
    !validateSessionScope(sessionScopeInput) ||
    sessionScopeInput.bundle?.bundleId !== verifiedBundleManifest.bundleId ||
    sessionScopeInput.bundle?.packageSha256 !== verifiedBundleManifest.package.sha256 ||
    Object.values(sessionScopeInput.policy?.sharing ?? {}).some((value) => value !== false)
  ) {
    throw new Error("Prepared package smoke session scope does not satisfy its safe schema contract.");
  }
  const sessionScopeReceipt = JSON.parse(
    (await run(executable, ["pilot", "scope", sessionScopePath, "--json"], {
      cwd: publisherDirectory,
    })).stdout,
  );
  if (
    !validateSessionScopeReceipt(sessionScopeReceipt) ||
    sessionScopeReceipt.binding?.bundleId !== sessionScopeInput.bundle.bundleId ||
    sessionScopeReceipt.binding?.packageSha256 !== sessionScopeInput.bundle.packageSha256 ||
    sessionScopeReceipt.bundleVerification?.manifestSha256 !== sessionScopeInput.bundle.manifestSha256 ||
    sessionScopeReceipt.bundleVerification?.sha256SumsSha256 !== sessionScopeInput.bundle.sha256SumsSha256 ||
    sessionScopeReceipt.scopeFileSha256 !== createHash("sha256").update(sessionScopeBytes).digest("hex") ||
    sessionScopeReceipt.policyValid !== true ||
    sessionScopeReceipt.publisherIdentity !== "not-established" ||
    sessionScopeReceipt.consentAuthenticity !== "not-established" ||
    sessionScopeReceipt.deviceEnvironment !== "not-established" ||
    sessionScopeReceipt.externalGrantGate !== "not-established" ||
    sessionScopeReceipt.grantReady !== false ||
    JSON.stringify(sessionScopeReceipt).includes(sessionScopePath) ||
    JSON.stringify(sessionScopeReceipt).includes("urn:launchrig:")
  ) {
    throw new Error("Installed pilot scope did not preserve its private claim-limited receipt contract.");
  }
  await writeFile(appApkPath, "package smoke app artifact changed after approval\n", { mode: 0o600 });
  let scopedPreflightFailure;
  try {
    await run(
      executable,
      [
        "pilot",
        "check",
        "--pilot",
        "package-smoke",
        "--scope",
        sessionScopePath,
        "--config",
        "launchrig.yml",
        "--json",
      ],
      { cwd: publisherDirectory },
    );
  } catch (error) {
    scopedPreflightFailure = error;
  }
  if (
    !(scopedPreflightFailure instanceof Error) ||
    !scopedPreflightFailure.message.includes("Configured app APK bytes do not match the approved scope") ||
    !scopedPreflightFailure.message.includes('"status": "skip"')
  ) {
    throw new Error("Installed scoped preflight did not refuse mismatched inputs before device access.");
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
  const bindingV1 = JSON.parse(
    (await run(executable, ["pilot", "binding", evidenceV1Path, "--json"], { cwd: publisherDirectory })).stdout,
  );
  if (
    bindingV1.kind !== "launchrig-pilot-evidence-binding-receipt" ||
    bindingV1.receiptSchemaVersion !== 1 ||
    bindingV1.binding?.evidenceId !== evidenceV1Core.evidenceId ||
    bindingV1.binding?.fileSha256 !== createHash("sha256").update(await readFile(evidenceV1Path)).digest("hex") ||
    bindingV1.binding?.evidenceSha256 !== sha256Value(evidenceV1Core) ||
    bindingV1.binding?.schemaVersion !== 1 ||
    bindingV1.technicalStatus !== "not-recomputable" ||
    bindingV1.externalGrantGate !== "not-established" ||
    bindingV1.grantReady !== false ||
    "fileIdentity" in bindingV1 ||
    JSON.stringify(bindingV1).includes(evidenceV1Path)
  ) {
    throw new Error("Installed evidence binding receipt did not preserve its path-omitting v1 contract.");
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
  const bindingV2Met = JSON.parse(
    (await run(executable, ["pilot", "binding", evidenceV2MetPath, "--json"], { cwd: publisherDirectory })).stdout,
  );
  if (
    bindingV2Met.receiptSchemaVersion !== 1 ||
    bindingV2Met.binding?.schemaVersion !== 2 ||
    bindingV2Met.technicalStatus !== "qualified-self-recorded" ||
    bindingV2Met.externalGrantGate !== "not-established" ||
    bindingV2Met.grantReady !== false
  ) {
    throw new Error("Installed evidence binding receipt did not preserve its qualified self-recorded boundary.");
  }

  const qualifiedV3Artifacts = [];
  for (const index of [41, 42, 43]) {
    const scopeSha256 = smokeDigest("qualified-v3-scope-" + index);
    const executionFingerprintSha256 = smokeDigest("qualified-v3-fingerprint-" + index);
    const metrics = {
      runAttempts: 3,
      qualifyingRuns: 3,
      passRate: 1,
      consecutivePasses: 3,
      medianRunDurationMs: 5 * 60_000,
      setupDurationMs: 20 * 60_000,
      executionFingerprintSha256,
      setupTargetMet: true,
      runtimeTargetMet: true,
      repeatabilityTargetMet: true,
    };
    const technicalPilot = {
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
    };
    const evidenceCore = {
      schemaVersion: 3,
      kind: "launchrig-pilot-evidence",
      evidenceId: smokeUuid(index),
      claimStatus: "self-recorded-unattested",
      sessionScope: {
        profile: "external-mwa-pilot-scope-v1",
        scopeSha256,
        claimStatus: "operator-prepared-unattested",
      },
      metrics,
      technicalPilot,
      runs: [20, 25, 30].map((elapsedMinutes, runIndex) => ({
        runId: "run-" + String(runIndex + 1).padStart(3, "0"),
        outcome: "passed",
        readiness: "Android/MWA Ready",
        durationMs: 5 * 60_000,
        elapsedSinceStartMs: elapsedMinutes * 60_000,
        executionFingerprintSha256,
        sessionScopeSha256: scopeSha256,
        scopeInputsMatched: true,
        launchRigVersion: installedPackage.version,
        physicalDevice: true,
        requiredChecksPassed: true,
        qualifying: true,
      })),
      claims,
    };
    const evidence = { ...evidenceCore, evidenceSha256: sha256Value(evidenceCore) };
    const evidencePath = path.join(publisherDirectory, "pilot-evidence-v3-qualified-" + index + ".json");
    const evidenceBytes = Buffer.from(JSON.stringify(evidence, null, 2) + "\n", "utf8");
    await writeFile(evidencePath, evidenceBytes, "utf8");

    const verified = JSON.parse(
      (await run(executable, ["pilot", "verify", evidencePath, "--json"], { cwd: publisherDirectory })).stdout,
    );
    if (
      verified.schemaVersion !== 3 ||
      verified.evidenceId !== evidence.evidenceId ||
      verified.integrityValid !== true ||
      verified.internalConsistencyValid !== true ||
      verified.claimStatus !== "self-recorded-unattested" ||
      verified.sessionScopeSha256 !== scopeSha256 ||
      verified.technicalPilot?.qualified !== true ||
      verified.reportedTechnicalTargetsMet !== true ||
      verified.grantReady !== false
    ) {
      throw new Error("Installed verifier did not recompute a qualified scope-linked evidence v3 result.");
    }

    const bindingV3 = JSON.parse(
      (await run(executable, ["pilot", "binding", evidencePath, "--json"], { cwd: publisherDirectory })).stdout,
    );
    if (
      bindingV3.receiptSchemaVersion !== 1 ||
      bindingV3.kind !== "launchrig-pilot-evidence-binding-receipt" ||
      bindingV3.binding?.evidenceId !== evidence.evidenceId ||
      bindingV3.binding?.fileSha256 !== createHash("sha256").update(evidenceBytes).digest("hex") ||
      bindingV3.binding?.evidenceSha256 !== evidence.evidenceSha256 ||
      bindingV3.binding?.schemaVersion !== 3 ||
      bindingV3.technicalStatus !== "qualified-self-recorded" ||
      bindingV3.externalGrantGate !== "not-established" ||
      bindingV3.grantReady !== false
    ) {
      throw new Error("Installed evidence binding receipt did not preserve the qualified evidence v3 boundary.");
    }
    qualifiedV3Artifacts.push({ evidencePath, scopeSha256, binding: bindingV3.binding });
  }
  if (
    new Set(qualifiedV3Artifacts.map((entry) => entry.binding.evidenceId)).size !== 3 ||
    new Set(qualifiedV3Artifacts.map((entry) => entry.binding.fileSha256)).size !== 3 ||
    new Set(qualifiedV3Artifacts.map((entry) => entry.scopeSha256)).size !== 3
  ) {
    throw new Error("Installed evidence v3 rehearsal did not produce three distinct scope-linked bindings.");
  }

  const auditRegister = async (name, candidates, evidencePaths, registerIndex) => {
    const registerPath = path.join(temporaryDirectory, name);
    await writeFile(
      registerPath,
      JSON.stringify(sealedPrivateRegister(candidates, registerIndex), null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(registerPath, 0o600);
    return JSON.parse(
      (
        await run(executable, ["cohort", "audit", registerPath, ...evidencePaths, "--json"], {
          cwd: installDirectory,
        })
      ).stdout,
    );
  };

  const qualifiedV3Audit = await auditRegister(
    "qualified-v3-private-register.json",
    qualifiedV3Artifacts.map((entry, index) => privateCandidate(index + 1, entry.binding, entry.scopeSha256)),
    qualifiedV3Artifacts.map((entry) => entry.evidencePath),
    11,
  );
  if (
    qualifiedV3Audit.kind !== "launchrig-private-cohort-register-audit" ||
    qualifiedV3Audit.register?.integrityRecorded !== true ||
    qualifiedV3Audit.summary?.candidateRecords !== 3 ||
    qualifiedV3Audit.summary?.matchedEvidenceBindings !== 3 ||
    qualifiedV3Audit.summary?.recomputedQualifiedV2Bindings !== 0 ||
    qualifiedV3Audit.summary?.recomputedQualifiedV3Bindings !== 3 ||
    qualifiedV3Audit.summary?.recordedIncludedWithQualifiedV2 !== 0 ||
    qualifiedV3Audit.summary?.recordedIncludedWithScopeQualifiedV3 !== 3 ||
    qualifiedV3Audit.summary?.distinctRecordedPublishersForQualifiedIncluded !== 3 ||
    qualifiedV3Audit.summary?.distinctRecordedProjectsForQualifiedIncluded !== 3 ||
    qualifiedV3Audit.summary?.recordedGovernanceAndTechnicalThresholdMet !== true ||
    qualifiedV3Audit.entries?.length !== 3 ||
    qualifiedV3Audit.entries.some(
      (entry) =>
        entry.governanceStatus !== "recorded-ready" ||
        entry.evidenceStatus !== "matched-v3-scope-qualified" ||
        entry.blockers?.length !== 0,
    ) ||
    !externalGateIsNotEstablished(qualifiedV3Audit.externalGrantGate) ||
    qualifiedV3Audit.grantReady !== false
  ) {
    throw new Error("Installed private cohort audit did not accept three matched qualified evidence v3 candidates.");
  }

  const mismatchedScopeCandidate = privateCandidate(
    11,
    qualifiedV3Artifacts[0].binding,
    smokeDigest("mismatched-recorded-scope"),
  );
  const mismatchedScopeAudit = await auditRegister(
    "mismatched-v3-private-register.json",
    [mismatchedScopeCandidate],
    [qualifiedV3Artifacts[0].evidencePath],
    12,
  );
  if (
    mismatchedScopeAudit.entries?.[0]?.governanceStatus !== "recorded-ready" ||
    mismatchedScopeAudit.entries?.[0]?.evidenceStatus !== "matched-v3-scope-mismatch" ||
    !mismatchedScopeAudit.entries?.[0]?.blockers?.includes("evidence-scope-mismatch") ||
    mismatchedScopeAudit.summary?.recordedIncludedWithScopeQualifiedV3 !== 0 ||
    mismatchedScopeAudit.summary?.recordedGovernanceAndTechnicalThresholdMet !== false ||
    !externalGateIsNotEstablished(mismatchedScopeAudit.externalGrantGate) ||
    mismatchedScopeAudit.grantReady !== false
  ) {
    throw new Error("Installed private cohort audit did not block a mismatched evidence v3 scope.");
  }

  const historicalV2Audit = await auditRegister(
    "historical-v2-private-register.json",
    [privateCandidate(12, bindingV2Met.binding, smokeDigest("historical-v2-scope"))],
    [evidenceV2MetPath],
    13,
  );
  if (
    historicalV2Audit.entries?.[0]?.governanceStatus !== "recorded-ready" ||
    historicalV2Audit.entries?.[0]?.evidenceStatus !== "matched-v2-qualified" ||
    !historicalV2Audit.entries?.[0]?.blockers?.includes("evidence-scope-unavailable") ||
    historicalV2Audit.summary?.recomputedQualifiedV2Bindings !== 1 ||
    historicalV2Audit.summary?.recomputedQualifiedV3Bindings !== 0 ||
    historicalV2Audit.summary?.recordedIncludedWithQualifiedV2 !== 1 ||
    historicalV2Audit.summary?.recordedIncludedWithScopeQualifiedV3 !== 0 ||
    historicalV2Audit.summary?.recordedGovernanceAndTechnicalThresholdMet !== false ||
    !externalGateIsNotEstablished(historicalV2Audit.externalGrantGate) ||
    historicalV2Audit.grantReady !== false
  ) {
    throw new Error("Installed private cohort audit did not keep evidence v2 outside scope-linked governance.");
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
