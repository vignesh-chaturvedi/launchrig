import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
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
  if (!installedFiles.includes("schemas/launchrig-private-cohort-audit.schema.json")) {
    throw new Error("Packed private cohort audit schema is missing.");
  }
  if (!installedFiles.includes("schemas/fixtures/launchrig-config-v1.conformance.json")) {
    throw new Error("Packed config v1 conformance corpus is missing.");
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
  new Ajv2020({ strict: true }).compile(publisherBundleSchema);
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
      ]) ||
    publisherBundleSchema.properties?.grantReady?.const !== false ||
    publisherBundleSchema.properties?.claims?.properties?.externalPublisher?.const !== "not-established" ||
    JSON.stringify(
      publisherBundleSchema.allOf?.[0]?.then?.properties?.consumerRehearsal?.properties?.checks?.const,
    ) !== JSON.stringify(v9RehearsalChecks) ||
    JSON.stringify(
      publisherBundleSchema.allOf?.[0]?.else?.then?.properties?.consumerRehearsal?.properties?.checks?.const,
    ) !== JSON.stringify(v8RehearsalChecks) ||
    JSON.stringify(
      publisherBundleSchema.allOf?.[0]?.else?.else?.then?.properties?.consumerRehearsal?.properties?.checks?.const,
    ) !== JSON.stringify(v7RehearsalChecks) ||
    JSON.stringify(
      publisherBundleSchema.allOf?.[0]?.else?.else?.else?.properties?.consumerRehearsal?.properties?.checks?.const,
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
  const validateSessionScope = new Ajv2020({ strict: true }).compile(sessionScopeSchema);
  const validateSessionScopeReceipt = new Ajv2020({ strict: true }).compile(sessionScopeReceiptSchema);
  if (
    sessionScopeSchema.properties?.kind?.const !== "launchrig-pilot-session-scope" ||
    sessionScopeSchema.properties?.policy?.properties?.physicalAndroidRequired?.const !== true ||
    sessionScopeSchema.properties?.policy?.properties?.valuableAssetsAllowed?.const !== false ||
    sessionScopeReceiptSchema.properties?.kind?.const !== "launchrig-pilot-session-scope-receipt" ||
    sessionScopeReceiptSchema.properties?.publisherIdentity?.const !== "not-established" ||
    sessionScopeReceiptSchema.properties?.consentAuthenticity?.const !== "not-established" ||
    sessionScopeReceiptSchema.properties?.externalGrantGate?.const !== "not-established" ||
    sessionScopeReceiptSchema.properties?.grantReady?.const !== false
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
  const privateAuditSchema = JSON.parse(
    await readFile(path.join(installedDirectory, "schemas", "launchrig-private-cohort-audit.schema.json"), "utf8"),
  );
  const coreRuleCatalogSchema = JSON.parse(
    await readFile(path.join(installedDirectory, "schemas", "launchrig-core-rule-catalog.schema.json"), "utf8"),
  );
  const configConformance = JSON.parse(
    await readFile(
      path.join(installedDirectory, "schemas", "fixtures", "launchrig-config-v1.conformance.json"),
      "utf8",
    ),
  );
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
    configConformance.parityCaseCount !== 23 ||
    configConformance.runtimeExtensionCaseCount !== 2 ||
    configConformance.grantMilestoneComplete !== false ||
    configConformance.cases?.length !== 25 ||
    new Set(configConformance.cases?.map((entry) => entry.id)).size !== 25 ||
    parityCases.length !== 23 ||
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
    "docs/config-v1-compatibility.md",
    "docs/github-action.md",
    "docs/phase-1.md",
    "docs/phase-2.md",
    "docs/phase-3-foundation.md",
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
    "schemas/fixtures/launchrig-config-v1.conformance.json",
    "schemas/launchrig-cohort-verification.schema.json",
    "schemas/launchrig-core-rule-catalog.schema.json",
    "schemas/launchrig-pilot-evidence-v1.schema.json",
    "schemas/launchrig-pilot-evidence-v2.schema.json",
    "schemas/launchrig-pilot-evidence-v3.schema.json",
    "schemas/launchrig-pilot-evidence-binding-receipt.schema.json",
    "schemas/launchrig-pilot-evidence.schema.json",
    "schemas/launchrig-pilot-session-scope-receipt.schema.json",
    "schemas/launchrig-pilot-session-scope.schema.json",
    "schemas/launchrig-private-cohort-audit.schema.json",
    "schemas/launchrig-private-cohort-register.schema.json",
    "schemas/launchrig-publisher-bundle.schema.json",
    "schemas/launchrig.schema.json",
  ];
  const expectedActionFiles = [
    "action.yml",
    "action/run-validation.mjs",
    "examples/github-actions/launchrig-validation.yml",
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
    expectedActionFiles.includes(file);
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
  if (!help.stdout.includes("launchrig pilot binding FILE")) {
    throw new Error("Installed CLI help is missing the public evidence binding receipt.");
  }
  if (!help.stdout.includes("launchrig pilot scope FILE")) {
    throw new Error("Installed CLI help is missing the private session scope receipt.");
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
  const starterSource = await readFile(path.join(publisherDirectory, "launchrig.yml"), "utf8");
  const promotedConfig = starterSource.replace(
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
  const sessionScopeInput = {
    schemaVersion: 1,
    kind: "launchrig-pilot-session-scope",
    profile: "external-mwa-pilot-scope-v1",
    scopeRef: "urn:launchrig:scope:123e4567-e89b-42d3-a456-426614174000",
    operatorRef: "urn:launchrig:operator:223e4567-e89b-42d3-a456-426614174000",
    pilotRef: "urn:launchrig:pilot:323e4567-e89b-42d3-a456-426614174000",
    deviceRef: "urn:launchrig:device:423e4567-e89b-42d3-a456-426614174000",
    bundle: {
      bundleId: "sha256:" + "a".repeat(64),
      manifestSha256: "b".repeat(64),
      sha256SumsSha256: "c".repeat(64),
      packageSha256: "d".repeat(64),
    },
    inputs: {
      configSha256: createHash("sha256").update(promotedConfig).digest("hex"),
      appBuildSha256: "e".repeat(64),
      walletArtifactSha256: "f".repeat(64),
      flows: await Promise.all(
        promotedScenarios.map(async ([id, kind]) => ({
          kind,
          scenarioId: id,
          fileSha256: createHash("sha256")
            .update(await readFile(path.join(publisherDirectory, "launchrig-flows", id + ".yaml")))
            .digest("hex"),
        })),
      ),
    },
    policy: {
      network: "devnet",
      walletMode: "mock-mwa",
      physicalAndroidRequired: true,
      attendedExecutionRequired: true,
      manualWalletActionsRequired: true,
      valuableAssetsAllowed: false,
      capture: { screenshots: "failure", includeLogcat: false, logcatLines: 200 },
      retention: { maxRuns: 5, expiresOn: "2030-12-31", deletionMethod: "standard-delete" },
      sharing: {
        publicEvidenceJson: true,
        sanitizedReports: false,
        publisherName: false,
        publisherLogo: false,
        approvedQuote: false,
        confirmedDefectRecord: false,
      },
    },
  };
  if (!validateSessionScope(sessionScopeInput)) {
    throw new Error("Package smoke session scope input does not satisfy its schema.");
  }
  const sessionScopeBytes = Buffer.from(JSON.stringify(sessionScopeInput, null, 2) + "\n", "utf8");
  await writeFile(sessionScopePath, sessionScopeBytes, { flag: "wx", mode: 0o600 });
  await chmod(sessionScopePath, 0o600);
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
