import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import {
  FixtureMatrixValidationError,
  createFixtureMatrixRun,
  evaluateFixtureMatrix,
  parseFixtureMatrixManifest,
  type FixtureMatrixCaseV1,
  type FixtureMatrixEvaluation,
  type FixtureMatrixManifestV1,
  type FixtureMatrixVariant,
} from "../fixtures/matrix.js";
import type { ResolvedLaunchRigConfig } from "../types.js";
import { loadConfig } from "../config/load.js";
import { redactJsonValue } from "../security/redact.js";
import { runProject } from "./run.js";
import type { RunOptions, RunOutput } from "../runner/orchestrator.js";

export const DEFAULT_FIXTURE_MATRIX_MANIFEST = "fixtures/launchrig-matrix.v1.json";

const CONTROLLED_DAPP_MANIFEST = "fixtures/launchrig-dapp-v0.2.0.json";
const MOCK_MWA_MANIFEST = "fixtures/mock-mwa-main.json";
const EXPECTED_APP_PACKAGE = "dev.launchrig.fixture";
const EXPECTED_WALLET_PACKAGE = "com.solana.mwallet";
const EXECUTION_ORDER: readonly FixtureMatrixVariant[] = ["broken", "fixed"];

interface ControlledCaseContract {
  id: string;
  scenarioId: string;
  scenarioKind: string;
  configPaths: Record<FixtureMatrixVariant, string>;
  flowPaths: Record<FixtureMatrixVariant, string>;
  installPolicies: Record<FixtureMatrixVariant, ResolvedLaunchRigConfig["project"]["installPolicy"]>;
  brokenFailureMarker: string;
  openLinkCount: number;
  requiresProcessDeath: boolean;
}

export const CONTROLLED_CASES = [
  {
    id: "rejection-recovery",
    scenarioId: "rejection-recovery",
    scenarioKind: "mwa-reject",
    configPaths: {
      broken: "launchrig-fixture-rejection-broken.yml",
      fixed: "launchrig-fixture-rejection-fixed.yml",
    },
    flowPaths: {
      broken: "launchrig-flows/fixture-rejection-broken.yaml",
      fixed: "launchrig-flows/fixture-rejection-fixed.yaml",
    },
    installPolicies: { broken: "always", fixed: "if-missing" },
    brokenFailureMarker: "id: request-pending",
    openLinkCount: 1,
    requiresProcessDeath: false,
  },
  {
    id: "stale-authorization-recovery",
    scenarioId: "stale-authorization-recovery",
    scenarioKind: "mwa-stale-authorization",
    configPaths: {
      broken: "launchrig-fixture-stale-authorization-broken.yml",
      fixed: "launchrig-fixture-stale-authorization-fixed.yml",
    },
    flowPaths: {
      broken: "launchrig-flows/fixture-stale-authorization-broken.yaml",
      fixed: "launchrig-flows/fixture-stale-authorization-fixed.yaml",
    },
    installPolicies: { broken: "if-missing", fixed: "if-missing" },
    brokenFailureMarker: "id: reauthorization-pending",
    openLinkCount: 1,
    requiresProcessDeath: false,
  },
  {
    id: "process-death-recovery",
    scenarioId: "process-death-recovery",
    scenarioKind: "mwa-process-death",
    configPaths: {
      broken: "launchrig-fixture-process-death-broken.yml",
      fixed: "launchrig-fixture-process-death-fixed.yml",
    },
    flowPaths: {
      broken: "launchrig-flows/fixture-process-death-broken.yaml",
      fixed: "launchrig-flows/fixture-process-death-fixed.yaml",
    },
    installPolicies: { broken: "if-missing", fixed: "if-missing" },
    brokenFailureMarker: "id: process-death-state",
    openLinkCount: 2,
    requiresProcessDeath: true,
  },
] as const satisfies readonly ControlledCaseContract[];

export type FixtureMatrixProjectRunner = (configPath: string, options?: RunOptions) => Promise<RunOutput>;

export interface RunFixtureMatrixOptions extends Omit<RunOptions, "scenarioId"> {
  cwd?: string;
  manifestPath?: string;
  brokenConfigPath?: string;
  fixedConfigPath?: string;
  projectRunner?: FixtureMatrixProjectRunner;
}

export interface FixtureArtifactProvenance {
  manifestPath: string;
  manifestSha256: string;
  artifactPath: string;
  packageName: string;
  versionName: string;
  versionCode: number;
  size: number;
  sha256: string;
}

export interface FixtureVariantProvenance {
  configPath: string;
  configSha256: string;
  flowPath: string;
  flowSha256: string;
  launchUri: string;
}

export interface FixtureMatrixProvenance {
  app: FixtureArtifactProvenance;
  wallet: FixtureArtifactProvenance;
  cases: FixtureMatrixCaseProvenance[];
}

export interface FixtureMatrixCaseProvenance {
  caseId: string;
  scenarioId: string;
  variants: Record<FixtureMatrixVariant, FixtureVariantProvenance>;
}

export interface FixtureMatrixExecution {
  caseId: string;
  scenarioId: string;
  variant: FixtureMatrixVariant;
  configPath: string;
  output: RunOutput;
}

export interface RunFixtureMatrixOutput {
  manifestPath: string;
  manifestSha256: string;
  provenance: FixtureMatrixProvenance;
  executions: FixtureMatrixExecution[];
  evaluation: FixtureMatrixEvaluation;
  exitCode: 0 | 1 | 3;
}

export class FixtureMatrixEnvironmentError extends Error {
  readonly issues: string[];

  constructor(issues: readonly string[]) {
    super("LaunchRig fixture matrix environment is not ready");
    this.name = "FixtureMatrixEnvironmentError";
    this.issues = [...issues];
  }
}

interface LoadedMatrixManifest {
  manifest: FixtureMatrixManifestV1;
  source: string;
}

interface FixtureArtifactContract {
  manifestPath: string;
  manifestSource: string;
  artifactPath: string;
  packageName: string;
  versionName: string;
  versionCode: number;
  size: number;
  sha256: string;
  network?: string;
  deepLinks?: Record<string, Record<FixtureMatrixVariant, string>>;
}

interface PreparedVariant {
  config: ResolvedLaunchRigConfig;
  configPath: string;
  flowSource: string;
  provenance: FixtureVariantProvenance;
}

interface PreparedCase {
  matrixCase: FixtureMatrixCaseV1;
  contract: ControlledCaseContract;
  variants: Record<FixtureMatrixVariant, PreparedVariant>;
}

interface MatrixPreflight {
  manifest: FixtureMatrixManifestV1;
  cases: PreparedCase[];
  manifestPath: string;
  manifestSha256: string;
  artifacts: { app: FixtureArtifactContract; wallet: FixtureArtifactContract };
  provenance: FixtureMatrixProvenance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Text(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(target: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function repositoryRelative(root: string, target: string, label: string): string {
  const relative = path.relative(root, path.resolve(target));
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) {
    throw new FixtureMatrixValidationError([label + " must be inside the LaunchRig workspace"]);
  }
  return (relative || ".").split(path.sep).join("/");
}

function isOutsideWorkspace(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep);
}

async function verifyRealWorkspacePath(root: string, target: string, label: string): Promise<void> {
  let resolvedRoot: string;
  let resolvedTarget: string;
  try {
    [resolvedRoot, resolvedTarget] = await Promise.all([realpath(root), realpath(target)]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FixtureMatrixValidationError(["Cannot resolve " + label + ": " + message]);
  }
  if (isOutsideWorkspace(resolvedRoot, resolvedTarget)) {
    throw new FixtureMatrixValidationError([label + " resolves outside the LaunchRig workspace"]);
  }
}

async function readText(target: string, label: string): Promise<string> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FixtureMatrixValidationError(["Cannot read " + label + ": " + message]);
  }
}

async function readJson(target: string, label: string): Promise<{ source: string; value: unknown }> {
  const source = await readText(target, label);
  try {
    return { source, value: JSON.parse(source) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FixtureMatrixValidationError(["Cannot parse " + label + ": " + message]);
  }
}

async function loadManifest(manifestPath: string): Promise<LoadedMatrixManifest> {
  const loaded = await readJson(manifestPath, "fixture matrix manifest");
  return { manifest: parseFixtureMatrixManifest(loaded.value), source: loaded.source };
}

function selectExecutableCases(manifest: FixtureMatrixManifestV1): PreparedCase[] {
  const issues: string[] = [];
  if (manifest.cases.length !== CONTROLLED_CASES.length) {
    issues.push("The controlled fixture runner requires exactly " + CONTROLLED_CASES.length + " ordered cases");
  }

  const cases = CONTROLLED_CASES.flatMap((contract, index): PreparedCase[] => {
    const matrixCase = manifest.cases[index];
    if (!matrixCase) return [];
    if (matrixCase.id !== contract.id) {
      issues.push("Fixture matrix case " + index + " must be " + contract.id);
    }
    if (matrixCase.scenarioId !== contract.scenarioId) {
      issues.push(contract.id + " scenarioId must be " + contract.scenarioId);
    }
    return [{ matrixCase, contract, variants: {} as Record<FixtureMatrixVariant, PreparedVariant> }];
  });

  if (issues.length > 0) throw new FixtureMatrixValidationError(issues);
  return cases;
}

function fixtureArtifactContract(
  root: string,
  manifestPath: string,
  source: string,
  value: unknown,
  role: "app" | "wallet",
): FixtureArtifactContract {
  const issues: string[] = [];
  const record = isRecord(value) ? value : {};
  if (!isRecord(value)) issues.push(role + " fixture manifest must be an object");
  if (record.schemaVersion !== 1) issues.push(role + " fixture schemaVersion must be 1");

  const packageName = typeof record.packageName === "string" ? record.packageName : "";
  const expectedPackage = role === "app" ? EXPECTED_APP_PACKAGE : EXPECTED_WALLET_PACKAGE;
  if (packageName !== expectedPackage) issues.push(role + " fixture packageName must be " + expectedPackage);

  const build = isRecord(record.build) ? record.build : {};
  const artifactNameValue = role === "app" ? build.artifactName : record.artifactName;
  const artifactName = typeof artifactNameValue === "string" ? artifactNameValue : "";
  if (!artifactName || path.basename(artifactName) !== artifactName || !artifactName.endsWith(".apk")) {
    issues.push(role + " fixture artifactName must be one APK filename");
  }

  const versionName = typeof record.versionName === "string" ? record.versionName : "";
  const versionCode = record.versionCode;
  if (!versionName) issues.push(role + " fixture versionName must be a non-empty string");
  if (!Number.isInteger(versionCode) || (versionCode as number) < 1) {
    issues.push(role + " fixture versionCode must be a positive integer");
  }

  const validated = isRecord(record.validatedArtifact) ? record.validatedArtifact : {};
  const size = validated.size;
  const sha256 = validated.sha256;
  if (!Number.isInteger(size) || (size as number) < 1) {
    issues.push(role + " validated artifact size must be a positive integer");
  }
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
    issues.push(role + " validated artifact sha256 must be 64 lowercase hexadecimal characters");
  }

  let deepLinks: Record<string, Record<FixtureMatrixVariant, string>> | undefined;
  let network: string | undefined;
  if (role === "app") {
    network = typeof record.network === "string" ? record.network : "";
    if (network !== "devnet") issues.push("app fixture network must be devnet");
    const links = isRecord(record.deepLinks) ? record.deepLinks : {};
    const parsedLinks: Record<string, Record<FixtureMatrixVariant, string>> = {};
    const expectedIds = new Set<string>(CONTROLLED_CASES.map((contract) => contract.id));
    for (const key of Object.keys(links)) {
      if (!expectedIds.has(key)) issues.push("app fixture deepLinks contains unsupported case " + key);
    }
    for (const contract of CONTROLLED_CASES) {
      const caseLinksValue = links[contract.id];
      const caseLinks = isRecord(caseLinksValue) ? caseLinksValue : {};
      if (typeof caseLinks.broken !== "string" || typeof caseLinks.fixed !== "string") {
        issues.push("app fixture deepLinks." + contract.id + " must contain broken and fixed URIs");
      } else {
        parsedLinks[contract.id] = { broken: caseLinks.broken, fixed: caseLinks.fixed };
      }
    }
    deepLinks = parsedLinks;
  }

  if (issues.length > 0) throw new FixtureMatrixValidationError(issues);
  return {
    manifestPath,
    manifestSource: source,
    artifactPath: path.join(root, ".launchrig", "cache", "apks", artifactName),
    packageName,
    versionName,
    versionCode: versionCode as number,
    size: size as number,
    sha256: sha256 as string,
    ...(network ? { network } : {}),
    ...(deepLinks ? { deepLinks } : {}),
  };
}

async function loadFixtureArtifactContract(
  root: string,
  manifestRelativePath: string,
  role: "app" | "wallet",
): Promise<FixtureArtifactContract> {
  const manifestPath = path.resolve(root, manifestRelativePath);
  repositoryRelative(root, manifestPath, role + " fixture manifest");
  await verifyRealWorkspacePath(root, manifestPath, role + " fixture manifest");
  const loaded = await readJson(manifestPath, role + " fixture manifest");
  return fixtureArtifactContract(root, manifestPath, loaded.source, loaded.value, role);
}

async function verifyArtifact(
  root: string,
  contract: FixtureArtifactContract,
  role: "app" | "wallet",
): Promise<FixtureArtifactProvenance> {
  repositoryRelative(root, contract.artifactPath, role + " fixture APK");
  let metadata;
  let digest;
  try {
    const [resolvedRoot, resolvedArtifact] = await Promise.all([realpath(root), realpath(contract.artifactPath)]);
    if (isOutsideWorkspace(resolvedRoot, resolvedArtifact)) {
      throw new FixtureMatrixValidationError([role + " fixture APK resolves outside the LaunchRig workspace"]);
    }
    [metadata, digest] = await Promise.all([stat(contract.artifactPath), sha256File(contract.artifactPath)]);
  } catch (error) {
    if (error instanceof FixtureMatrixValidationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new FixtureMatrixEnvironmentError(["Cannot verify " + role + " fixture APK: " + message]);
  }
  const issues: string[] = [];
  if (!metadata.isFile()) issues.push(role + " fixture APK must be a regular file");
  if (metadata.size !== contract.size) {
    issues.push(role + " fixture APK size mismatch: expected " + contract.size + ", received " + metadata.size);
  }
  if (digest !== contract.sha256) {
    issues.push(role + " fixture APK SHA-256 mismatch: expected " + contract.sha256 + ", received " + digest);
  }
  if (issues.length > 0) throw new FixtureMatrixValidationError(issues);

  return {
    manifestPath: repositoryRelative(root, contract.manifestPath, role + " fixture manifest"),
    manifestSha256: sha256Text(contract.manifestSource),
    artifactPath: repositoryRelative(root, contract.artifactPath, role + " fixture APK"),
    packageName: contract.packageName,
    versionName: contract.versionName,
    versionCode: contract.versionCode,
    size: metadata.size,
    sha256: digest,
  };
}

function collectOpenLinks(value: unknown, links: string[], invalid: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectOpenLinks(entry, links, invalid);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "openLink") {
      collectOpenLinks(entry, links, invalid);
      continue;
    }
    if (typeof entry === "string") links.push(entry);
    else if (isRecord(entry) && typeof entry.link === "string") links.push(entry.link);
    else invalid.push("openLink must be a string or contain a string link");
  }
}

function collectCommandValues(value: unknown, command: string, values: unknown[]): void {
  if (value === command) {
    values.push(true);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectCommandValues(entry, command, values);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === command) values.push(entry);
    collectCommandValues(entry, command, values);
  }
}

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

async function inspectFlow(
  root: string,
  flowPath: string,
  expectedPackage: string,
  expectedLaunchUri: string,
  variant: FixtureMatrixVariant,
  contract: ControlledCaseContract,
): Promise<{ flowPath: string; flowSha256: string; source: string }> {
  const label = contract.id + " " + variant;
  await verifyRealWorkspacePath(root, flowPath, label + " Maestro flow");
  const source = await readText(flowPath, label + " Maestro flow");
  const documents = parseAllDocuments(source);
  const issues = documents.flatMap((document) => document.errors.map((error) => error.message));
  if (documents.length !== 2) issues.push(label + " Maestro flow must contain metadata and command documents");

  let metadata: unknown;
  let commands: unknown;
  try {
    metadata = documents[0]?.toJSON();
    commands = documents[1]?.toJSON();
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(metadata) || metadata.appId !== expectedPackage) {
    issues.push(label + " Maestro flow appId must be " + expectedPackage);
  }
  const links: string[] = [];
  collectOpenLinks(commands, links, issues);
  if (links.length !== contract.openLinkCount || links.some((link) => link !== expectedLaunchUri)) {
    issues.push(
      label +
        " Maestro flow must contain exactly " +
        contract.openLinkCount +
        " openLink command(s) for " +
        expectedLaunchUri,
    );
  }

  const killAppValues: unknown[] = [];
  const stopAppValues: unknown[] = [];
  collectCommandValues(commands, "killApp", killAppValues);
  collectCommandValues(commands, "stopApp", stopAppValues);
  if (contract.requiresProcessDeath) {
    if (stopAppValues.length !== 1 || stopAppValues[0] !== expectedPackage) {
      issues.push(label + " Maestro flow must contain exactly one stopApp targeting " + expectedPackage);
    }
    if (killAppValues.length > 0) issues.push(label + " Maestro flow must not contain killApp");
  } else if (killAppValues.length > 0) {
    issues.push(label + " Maestro flow must not contain killApp");
  } else if (stopAppValues.length > 0) {
    issues.push(label + " Maestro flow must not contain stopApp");
  }

  for (const forbidden of ["clearState", "clearKeychain", "runScript", "evalScript"]) {
    const values: unknown[] = [];
    collectCommandValues(commands, forbidden, values);
    if (values.length > 0) issues.push(label + " Maestro flow must not contain " + forbidden);
  }
  if (issues.length > 0) throw new FixtureMatrixValidationError(issues);
  return {
    flowPath: repositoryRelative(root, flowPath, label + " Maestro flow"),
    flowSha256: sha256Text(source),
    source,
  };
}

function normalizePairedFlow(
  source: string,
  launchUri: string,
  variant: FixtureMatrixVariant,
  contract: ControlledCaseContract,
): string {
  const variantSelector = 'text: "^' + variant + '$"';
  if (occurrences(source, launchUri) !== contract.openLinkCount || occurrences(source, variantSelector) !== 1) {
    throw new FixtureMatrixValidationError([
      contract.id + " " + variant + " flow does not have the expected controlled URI and variant selector count",
    ]);
  }
  return source
    .replaceAll(launchUri, "launchrig://fixture/CONTROLLED?variant=VARIANT")
    .replaceAll(variantSelector, 'text: "^VARIANT$"');
}

function validateConfigContract(input: {
  root: string;
  config: ResolvedLaunchRigConfig;
  variant: FixtureMatrixVariant;
  matrixCase: FixtureMatrixCaseV1;
  contract: ControlledCaseContract;
  app: FixtureArtifactContract;
  wallet: FixtureArtifactContract;
}): void {
  const { root, config, variant, matrixCase, contract, app, wallet } = input;
  const issues: string[] = [];
  const label = contract.id + " " + variant;
  const expectedPolicy = contract.installPolicies[variant];
  const expectedConfigPath = path.join(root, contract.configPaths[variant]);
  const expectedFlowPath = path.join(root, contract.flowPaths[variant]);
  if (config.configPath !== expectedConfigPath) {
    issues.push(label + " config must use " + repositoryRelative(root, expectedConfigPath, label + " config"));
  }
  if (config.project.packageName !== app.packageName) {
    issues.push(label + " project packageName must be " + app.packageName);
  }
  if (!config.project.install || config.project.installPolicy !== expectedPolicy) {
    issues.push(label + " project install must be true with installPolicy " + expectedPolicy);
  }
  if (config.resolvedApk !== app.artifactPath) {
    issues.push(label + " project APK must be " + repositoryRelative(root, app.artifactPath, "app APK"));
  }
  if (config.target.network !== "devnet") issues.push(label + " target network must be devnet");
  if (!config.device.requirePhysical) issues.push(label + " config must require a physical Android device");
  if (config.device.minimumApiLevel !== 26) issues.push(label + " minimum API level must be 26");
  if (config.wallet.mode !== "mock-mwa" || config.wallet.packageName !== wallet.packageName) {
    issues.push(label + " wallet must be mock-mwa package " + wallet.packageName);
  }
  if (!config.wallet.install || config.wallet.installPolicy !== expectedPolicy) {
    issues.push(label + " wallet install must be true with installPolicy " + expectedPolicy);
  }
  if (config.resolvedWalletApk !== wallet.artifactPath) {
    issues.push(label + " wallet APK must be " + repositoryRelative(root, wallet.artifactPath, "wallet APK"));
  }
  if (config.scenarios.length !== 1) {
    issues.push(label + " config must contain exactly one scenario");
  }
  const scenario = config.scenarios[0];
  if (
    !scenario ||
    scenario.id !== matrixCase.scenarioId ||
    scenario.kind !== contract.scenarioKind ||
    !scenario.required
  ) {
    issues.push(
      label + " config must contain one required " + contract.scenarioKind + " scenario " + matrixCase.scenarioId,
    );
  }
  if (scenario && scenario.resolvedFlow !== expectedFlowPath) {
    issues.push(label + " scenario must use " + repositoryRelative(root, expectedFlowPath, label + " flow"));
  }
  const expectedTimeout = contract.requiresProcessDeath ? 150000 : 120000;
  if (scenario && scenario.timeoutMs !== expectedTimeout) {
    issues.push(label + " scenario timeout must be " + expectedTimeout + " milliseconds");
  }
  const expectedArtifactDirectory = path.join(
    root,
    ".launchrig",
    "results",
    "fixture-matrix",
    contract.id,
    variant,
  );
  if (config.resolvedArtifactDirectory !== expectedArtifactDirectory) {
    issues.push(label + " artifacts must use " + repositoryRelative(root, expectedArtifactDirectory, label + " artifacts"));
  }
  if (config.artifacts.screenshots !== "failure") issues.push(label + " screenshots must be failure-only");
  if (config.privacy.includeLogcat) issues.push(label + " must keep logcat disabled");
  if (config.tooling.maestro !== "./.launchrig/tools/maestro-2.8.0/maestro/bin/maestro") {
    issues.push(label + " must pin Maestro 2.8.0");
  }
  repositoryRelative(root, config.configPath, label + " config");
  repositoryRelative(root, config.resolvedArtifactDirectory, label + " artifact directory");
  if (scenario) repositoryRelative(root, scenario.resolvedFlow, label + " Maestro flow");
  if (issues.length > 0) throw new FixtureMatrixValidationError(issues);
}

async function preflightFixtureMatrix(input: {
  root: string;
  manifestPath: string;
}): Promise<MatrixPreflight> {
  const expectedManifestPath = path.join(input.root, DEFAULT_FIXTURE_MATRIX_MANIFEST);
  if (input.manifestPath !== expectedManifestPath) {
    throw new FixtureMatrixValidationError([
      "The controlled fixture matrix must use " + DEFAULT_FIXTURE_MATRIX_MANIFEST,
    ]);
  }

  const configPaths = CONTROLLED_CASES.flatMap((contract) =>
    EXECUTION_ORDER.map((variant) => path.join(input.root, contract.configPaths[variant])),
  );
  await Promise.all([
    verifyRealWorkspacePath(input.root, input.manifestPath, "fixture matrix manifest"),
    ...configPaths.map((configPath) =>
      verifyRealWorkspacePath(input.root, configPath, repositoryRelative(input.root, configPath, "fixture config")),
    ),
  ]);
  const manifestRelativePath = repositoryRelative(input.root, input.manifestPath, "fixture matrix manifest");
  const [loadedManifest, app, wallet, ...loadedConfigs] = await Promise.all([
    loadManifest(input.manifestPath),
    loadFixtureArtifactContract(input.root, CONTROLLED_DAPP_MANIFEST, "app"),
    loadFixtureArtifactContract(input.root, MOCK_MWA_MANIFEST, "wallet"),
    ...configPaths.map((configPath) => loadConfig(configPath)),
  ]);
  const selectedCases = selectExecutableCases(loadedManifest.manifest);
  const configByPath = new Map(configPaths.map((configPath, index) => [configPath, loadedConfigs[index]]));
  const issues: string[] = [];
  for (const selected of selectedCases) {
    for (const variant of EXECUTION_ORDER) {
      const appLink = app.deepLinks?.[selected.contract.id]?.[variant];
      const matrixLink = selected.matrixCase.expectations[variant].launchUri;
      if (appLink !== matrixLink) {
        issues.push(selected.contract.id + " " + variant + " launch URI differs between the app and matrix manifests");
      }
      const configPath = path.join(input.root, selected.contract.configPaths[variant]);
      const config = configByPath.get(configPath);
      if (!config) throw new Error("Fixture matrix invariant failed: config was not loaded");
      try {
        validateConfigContract({
          root: input.root,
          config,
          variant,
          matrixCase: selected.matrixCase,
          contract: selected.contract,
          app,
          wallet,
        });
      } catch (error) {
        if (error instanceof FixtureMatrixValidationError) issues.push(...error.issues);
        else throw error;
      }
    }
  }
  if (issues.length > 0) throw new FixtureMatrixValidationError(issues);

  const preparedCases: PreparedCase[] = [];
  for (const selected of selectedCases) {
    const variantEntries = await Promise.all(
      EXECUTION_ORDER.map(async (variant): Promise<[FixtureMatrixVariant, PreparedVariant]> => {
        const absoluteConfigPath = path.join(input.root, selected.contract.configPaths[variant]);
        const config = configByPath.get(absoluteConfigPath);
        if (!config) throw new Error("Fixture matrix invariant failed: config was not loaded");
        const scenario = config.scenarios[0];
        if (!scenario) throw new Error("Fixture matrix invariant failed: scenario was not found");
        const expectedLaunchUri = selected.matrixCase.expectations[variant].launchUri;
        const label = selected.contract.id + " " + variant;
        const [configSource, flow] = await Promise.all([
          readText(config.configPath, label + " config"),
          inspectFlow(
            input.root,
            scenario.resolvedFlow,
            app.packageName,
            expectedLaunchUri,
            variant,
            selected.contract,
          ),
        ]);
        const expectation = selected.matrixCase.expectations[variant];
        const configSha256 = sha256Text(configSource);
        if (configSha256 !== expectation.configSha256) {
          throw new FixtureMatrixValidationError([
            label + " config SHA-256 differs from the controlled matrix manifest",
          ]);
        }
        if (flow.flowSha256 !== expectation.flowSha256) {
          throw new FixtureMatrixValidationError([
            label + " flow SHA-256 differs from the controlled matrix manifest",
          ]);
        }
        const configPath = repositoryRelative(input.root, config.configPath, label + " config");
        return [
          variant,
          {
            config,
            configPath,
            flowSource: flow.source,
            provenance: {
              configPath,
              configSha256,
              flowPath: flow.flowPath,
              flowSha256: flow.flowSha256,
              launchUri: expectedLaunchUri,
            },
          },
        ];
      }),
    );
    const variants = Object.fromEntries(variantEntries) as Record<FixtureMatrixVariant, PreparedVariant>;
    const normalizedBroken = normalizePairedFlow(
      variants.broken.flowSource,
      selected.matrixCase.expectations.broken.launchUri,
      "broken",
      selected.contract,
    );
    const normalizedFixed = normalizePairedFlow(
      variants.fixed.flowSource,
      selected.matrixCase.expectations.fixed.launchUri,
      "fixed",
      selected.contract,
    );
    if (normalizedBroken !== normalizedFixed) {
      throw new FixtureMatrixValidationError([
        selected.contract.id +
          " broken and fixed flows must be identical except for every controlled variant URI and one label",
      ]);
    }
    preparedCases.push({ matrixCase: selected.matrixCase, contract: selected.contract, variants });
  }

  const [appProvenance, walletProvenance] = await Promise.all([
    verifyArtifact(input.root, app, "app"),
    verifyArtifact(input.root, wallet, "wallet"),
  ]);
  return {
    manifest: loadedManifest.manifest,
    cases: preparedCases,
    manifestPath: manifestRelativePath,
    manifestSha256: sha256Text(loadedManifest.source),
    artifacts: { app, wallet },
    provenance: {
      app: appProvenance,
      wallet: walletProvenance,
      cases: preparedCases.map((prepared) => ({
        caseId: prepared.matrixCase.id,
        scenarioId: prepared.matrixCase.scenarioId,
        variants: {
          broken: prepared.variants.broken.provenance,
          fixed: prepared.variants.fixed.provenance,
        },
      })),
    },
  };
}

function projectRunOptions(options: RunFixtureMatrixOptions, scenarioId: string): RunOptions {
  return {
    scenarioId,
    ...(options.deviceSerial ? { deviceSerial: options.deviceSerial } : {}),
    ...(options.adbPath ? { adbPath: options.adbPath } : {}),
    ...(options.maestroPath ? { maestroPath: options.maestroPath } : {}),
    ...(options.env ? { env: options.env } : {}),
  };
}

async function verifyPreparedVariantIntegrity(input: {
  root: string;
  prepared: PreparedVariant;
  label: string;
  phase: string;
}): Promise<void> {
  const { root, prepared, label, phase } = input;
  const scenario = prepared.config.scenarios[0];
  if (!scenario) throw new Error("Fixture matrix invariant failed: scenario was not found");

  await Promise.all([
    verifyRealWorkspacePath(root, prepared.config.configPath, label + " config"),
    verifyRealWorkspacePath(root, scenario.resolvedFlow, label + " Maestro flow"),
  ]);
  const [configSource, flowSource] = await Promise.all([
    readText(prepared.config.configPath, label + " config"),
    readText(scenario.resolvedFlow, label + " Maestro flow"),
  ]);
  const issues: string[] = [];
  if (sha256Text(configSource) !== prepared.provenance.configSha256) {
    issues.push(label + " config changed after controlled matrix preflight " + phase);
  }
  if (sha256Text(flowSource) !== prepared.provenance.flowSha256) {
    issues.push(label + " Maestro flow changed after controlled matrix preflight " + phase);
  }
  if (issues.length > 0) throw new FixtureMatrixValidationError(issues);
}

async function verifyPreparedMatrixIntegrity(
  root: string,
  cases: readonly PreparedCase[],
  phase: string,
): Promise<void> {
  for (const preparedCase of cases) {
    for (const variant of EXECUTION_ORDER) {
      await verifyPreparedVariantIntegrity({
        root,
        prepared: preparedCase.variants[variant],
        label: preparedCase.matrixCase.id + " " + variant,
        phase,
      });
    }
  }
}

function publicRunOutput(
  root: string,
  output: RunOutput,
  label: string,
  redactPatterns: string[],
): RunOutput {
  return {
    ...output,
    report: redactJsonValue(output.report, redactPatterns).value,
    artifacts: {
      ...output.artifacts,
      directory: repositoryRelative(root, output.artifacts.directory, label + " artifact directory"),
      json: repositoryRelative(root, output.artifacts.json, label + " JSON report"),
      html: repositoryRelative(root, output.artifacts.html, label + " HTML report"),
      junit: repositoryRelative(root, output.artifacts.junit, label + " JUnit report"),
    },
  };
}

function validatePackageEvidence(input: {
  label: string;
  actual: RunOutput["report"]["app"] | undefined;
  expected: FixtureArtifactProvenance;
  issues: string[];
}): void {
  const { label, actual, expected, issues } = input;
  if (!actual) {
    issues.push(label + " package evidence is missing");
    return;
  }
  if (actual.packageName !== expected.packageName) {
    issues.push(label + " package evidence must identify " + expected.packageName);
  }
  if (actual.versionName !== expected.versionName) {
    issues.push(label + " package versionName must be " + expected.versionName);
  }
  if (actual.versionCode !== String(expected.versionCode)) {
    issues.push(label + " package versionCode must be " + expected.versionCode);
  }
}

function validateExecutionEvidence(
  execution: FixtureMatrixExecution,
  prepared: PreparedVariant,
  contract: ControlledCaseContract,
  provenance: FixtureMatrixProvenance,
): string[] {
  const issues: string[] = [];
  const report = execution.output.report;
  const prefix = execution.caseId + " " + execution.variant + " report ";
  if (report.project !== prepared.config.project.name) issues.push(prefix + "project name differs from its config");
  if (report.packageName !== provenance.app.packageName) {
    issues.push(prefix + "packageName must be " + provenance.app.packageName);
  }
  if (report.network !== "devnet") issues.push(prefix + "network must be devnet");
  validatePackageEvidence({ label: prefix + "app", actual: report.app, expected: provenance.app, issues });
  validatePackageEvidence({ label: prefix + "wallet", actual: report.wallet, expected: provenance.wallet, issues });
  if (!report.device) {
    issues.push(prefix + "physical-device evidence is missing");
  } else {
    if (report.device.isEmulator) issues.push(prefix + "must come from a physical Android device");
    if (!report.device.serial.startsWith("***")) issues.push(prefix + "device identifier must be masked");
  }

  const requiredEvidenceChecks = [
    "tool.adb",
    "device.connected",
    "device.api",
    "app.install",
    "app.installed",
    "wallet.install",
    "wallet.installed",
    "tool.maestro",
  ];
  for (const checkId of requiredEvidenceChecks) {
    const matches = report.checks.filter((check) => check.id === checkId);
    if (matches.length !== 1) {
      issues.push(prefix + "must contain exactly one " + checkId + " evidence check");
      continue;
    }
    const check = matches[0];
    if (!check || !check.required || check.status !== "pass") {
      issues.push(prefix + checkId + " evidence check must be required and pass");
    }
  }
  if (execution.variant === "broken") {
    const target = report.checks.find((check) => check.id === "scenario." + execution.scenarioId);
    if (
      target?.status === "fail" &&
      (!target.details?.includes("Assertion is false") || !target.details.includes(contract.brokenFailureMarker))
    ) {
      issues.push(prefix + "must fail at the controlled " + contract.brokenFailureMarker + " assertion");
    }
  }
  return issues;
}

export async function runFixtureMatrix(options: RunFixtureMatrixOptions = {}): Promise<RunFixtureMatrixOutput> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  try {
    await realpath(cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FixtureMatrixEnvironmentError(["Cannot resolve the LaunchRig workspace: " + message]);
  }
  const manifestPath = path.resolve(cwd, options.manifestPath ?? DEFAULT_FIXTURE_MATRIX_MANIFEST);
  if (options.brokenConfigPath || options.fixedConfigPath) {
    throw new FixtureMatrixValidationError([
      "The controlled fixture matrix does not accept alternate config paths",
    ]);
  }
  const preflight = await preflightFixtureMatrix({ root: cwd, manifestPath });
  const projectRunner = options.projectRunner ?? runProject;
  const executions: FixtureMatrixExecution[] = [];

  for (const preparedCase of preflight.cases) {
    for (const variant of EXECUTION_ORDER) {
      const prepared = preparedCase.variants[variant];
      const label = preparedCase.matrixCase.id + " " + variant;
      await verifyPreparedMatrixIntegrity(cwd, preflight.cases, "before " + label + " execution");
      let output: RunOutput;
      try {
        output = await projectRunner(
          prepared.config.configPath,
          projectRunOptions(options, preparedCase.matrixCase.scenarioId),
        );
      } finally {
        await verifyPreparedMatrixIntegrity(cwd, preflight.cases, "after " + label + " execution");
      }
      executions.push({
        caseId: preparedCase.matrixCase.id,
        scenarioId: preparedCase.matrixCase.scenarioId,
        variant,
        configPath: prepared.configPath,
        output: publicRunOutput(
          cwd,
          output,
          preparedCase.matrixCase.id + " " + variant,
          prepared.config.privacy.redactPatterns,
        ),
      });
    }
  }

  const setupError = executions.some(
    (execution) => execution.output.exitCode === 3 || execution.output.report.outcome === "setup-error",
  );
  if (!setupError) {
    const evidenceIssues = executions.flatMap((execution) => {
      const preparedCase = preflight.cases.find((entry) => entry.matrixCase.id === execution.caseId);
      if (!preparedCase) return ["Execution references an unknown controlled case " + execution.caseId];
      return validateExecutionEvidence(
        execution,
        preparedCase.variants[execution.variant],
        preparedCase.contract,
        preflight.provenance,
      );
    });
    if (evidenceIssues.length > 0) throw new FixtureMatrixValidationError(evidenceIssues);
  }

  await Promise.all([
    verifyArtifact(cwd, preflight.artifacts.app, "app"),
    verifyArtifact(cwd, preflight.artifacts.wallet, "wallet"),
  ]);

  const evaluation = evaluateFixtureMatrix(
    preflight.manifest,
    executions.map((execution) =>
      createFixtureMatrixRun({
        caseId: execution.caseId,
        variant: execution.variant,
        scenarioId: execution.scenarioId,
        exitCode: execution.output.exitCode,
        report: execution.output.report,
      }),
    ),
  );
  return {
    manifestPath: preflight.manifestPath,
    manifestSha256: preflight.manifestSha256,
    provenance: preflight.provenance,
    executions,
    evaluation,
    exitCode: setupError ? 3 : evaluation.accepted ? 0 : 1,
  };
}
