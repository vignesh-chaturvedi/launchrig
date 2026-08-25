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
export const DEFAULT_BROKEN_FIXTURE_CONFIG = "launchrig-fixture-broken.yml";
export const DEFAULT_FIXED_FIXTURE_CONFIG = "launchrig-fixture-fixed.yml";

const CONTROLLED_DAPP_MANIFEST = "fixtures/launchrig-dapp-v0.1.0.json";
const MOCK_MWA_MANIFEST = "fixtures/mock-mwa-main.json";
const REJECTION_RECOVERY_CASE_ID = "rejection-recovery";
const EXPECTED_APP_PACKAGE = "dev.launchrig.fixture";
const EXPECTED_WALLET_PACKAGE = "com.solana.mwallet";
const EXECUTION_ORDER: readonly FixtureMatrixVariant[] = ["broken", "fixed"];

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
  deepLinks?: Record<FixtureMatrixVariant, string>;
}

interface PreparedVariant {
  config: ResolvedLaunchRigConfig;
  configPath: string;
  flowSource: string;
  provenance: FixtureVariantProvenance;
}

interface MatrixPreflight {
  matrixCase: FixtureMatrixCaseV1;
  manifestPath: string;
  manifestSha256: string;
  artifacts: { app: FixtureArtifactContract; wallet: FixtureArtifactContract };
  variants: Record<FixtureMatrixVariant, PreparedVariant>;
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

function selectExecutableCase(manifest: FixtureMatrixManifestV1): FixtureMatrixCaseV1 {
  const executable = manifest.cases.filter((matrixCase) => matrixCase.id === REJECTION_RECOVERY_CASE_ID);
  if (manifest.cases.length !== 1 || executable.length !== 1) {
    throw new FixtureMatrixValidationError([
      "The controlled fixture runner requires exactly one " + REJECTION_RECOVERY_CASE_ID + " case",
    ]);
  }
  const matrixCase = executable[0];
  if (!matrixCase) throw new Error("Fixture matrix invariant failed: executable case was not found");
  return matrixCase;
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

  let deepLinks: Record<FixtureMatrixVariant, string> | undefined;
  let network: string | undefined;
  if (role === "app") {
    network = typeof record.network === "string" ? record.network : "";
    if (network !== "devnet") issues.push("app fixture network must be devnet");
    const links = isRecord(record.deepLinks) ? record.deepLinks : {};
    if (typeof links.broken !== "string" || typeof links.fixed !== "string") {
      issues.push("app fixture deepLinks must contain broken and fixed URIs");
    } else {
      deepLinks = { broken: links.broken, fixed: links.fixed };
    }
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

async function inspectFlow(
  root: string,
  flowPath: string,
  expectedPackage: string,
  expectedLaunchUri: string,
  variant: FixtureMatrixVariant,
): Promise<{ flowPath: string; flowSha256: string; source: string }> {
  await verifyRealWorkspacePath(root, flowPath, variant + " Maestro flow");
  const source = await readText(flowPath, variant + " Maestro flow");
  const documents = parseAllDocuments(source);
  const issues = documents.flatMap((document) => document.errors.map((error) => error.message));
  if (documents.length !== 2) issues.push(variant + " Maestro flow must contain metadata and command documents");

  let metadata: unknown;
  let commands: unknown;
  try {
    metadata = documents[0]?.toJSON();
    commands = documents[1]?.toJSON();
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(metadata) || metadata.appId !== expectedPackage) {
    issues.push(variant + " Maestro flow appId must be " + expectedPackage);
  }
  const links: string[] = [];
  collectOpenLinks(commands, links, issues);
  if (links.length !== 1 || links[0] !== expectedLaunchUri) {
    issues.push(variant + " Maestro flow must contain exactly one openLink for " + expectedLaunchUri);
  }
  if (issues.length > 0) throw new FixtureMatrixValidationError(issues);
  return {
    flowPath: repositoryRelative(root, flowPath, variant + " Maestro flow"),
    flowSha256: sha256Text(source),
    source,
  };
}

function validateConfigContract(input: {
  root: string;
  config: ResolvedLaunchRigConfig;
  variant: FixtureMatrixVariant;
  matrixCase: FixtureMatrixCaseV1;
  app: FixtureArtifactContract;
  wallet: FixtureArtifactContract;
}): void {
  const { root, config, variant, matrixCase, app, wallet } = input;
  const issues: string[] = [];
  const expectedPolicy = variant === "broken" ? "always" : "if-missing";
  const expectedConfigPath = path.join(
    root,
    variant === "broken" ? DEFAULT_BROKEN_FIXTURE_CONFIG : DEFAULT_FIXED_FIXTURE_CONFIG,
  );
  const expectedFlowPath = path.join(root, "launchrig-flows", "fixture-rejection-" + variant + ".yaml");
  if (config.configPath !== expectedConfigPath) {
    issues.push(variant + " config must use " + repositoryRelative(root, expectedConfigPath, variant + " config"));
  }
  if (config.project.packageName !== app.packageName) {
    issues.push(variant + " project packageName must be " + app.packageName);
  }
  if (!config.project.install || config.project.installPolicy !== expectedPolicy) {
    issues.push(variant + " project install must be true with installPolicy " + expectedPolicy);
  }
  if (config.resolvedApk !== app.artifactPath) {
    issues.push(variant + " project APK must be " + repositoryRelative(root, app.artifactPath, "app APK"));
  }
  if (config.target.network !== "devnet") issues.push(variant + " target network must be devnet");
  if (!config.device.requirePhysical) issues.push(variant + " config must require a physical Android device");
  if (config.wallet.mode !== "mock-mwa" || config.wallet.packageName !== wallet.packageName) {
    issues.push(variant + " wallet must be mock-mwa package " + wallet.packageName);
  }
  if (!config.wallet.install || config.wallet.installPolicy !== expectedPolicy) {
    issues.push(variant + " wallet install must be true with installPolicy " + expectedPolicy);
  }
  if (config.resolvedWalletApk !== wallet.artifactPath) {
    issues.push(variant + " wallet APK must be " + repositoryRelative(root, wallet.artifactPath, "wallet APK"));
  }
  if (config.scenarios.length !== 1) {
    issues.push(variant + " config must contain exactly one scenario");
  }
  const scenario = config.scenarios[0];
  if (!scenario || scenario.id !== matrixCase.scenarioId || scenario.kind !== "mwa-reject" || !scenario.required) {
    issues.push(variant + " config must contain one required mwa-reject scenario " + matrixCase.scenarioId);
  }
  if (scenario && scenario.resolvedFlow !== expectedFlowPath) {
    issues.push(variant + " scenario must use " + repositoryRelative(root, expectedFlowPath, variant + " flow"));
  }
  repositoryRelative(root, config.configPath, variant + " config");
  repositoryRelative(root, config.resolvedArtifactDirectory, variant + " artifact directory");
  if (scenario) repositoryRelative(root, scenario.resolvedFlow, variant + " Maestro flow");
  if (issues.length > 0) throw new FixtureMatrixValidationError(issues);
}

async function preflightFixtureMatrix(input: {
  root: string;
  manifestPath: string;
  configPaths: Record<FixtureMatrixVariant, string>;
}): Promise<MatrixPreflight> {
  const expectedManifestPath = path.join(input.root, DEFAULT_FIXTURE_MATRIX_MANIFEST);
  const expectedConfigPaths: Record<FixtureMatrixVariant, string> = {
    broken: path.join(input.root, DEFAULT_BROKEN_FIXTURE_CONFIG),
    fixed: path.join(input.root, DEFAULT_FIXED_FIXTURE_CONFIG),
  };
  const pathIssues: string[] = [];
  if (input.manifestPath !== expectedManifestPath) {
    pathIssues.push("The controlled fixture matrix must use " + DEFAULT_FIXTURE_MATRIX_MANIFEST);
  }
  for (const variant of EXECUTION_ORDER) {
    if (input.configPaths[variant] !== expectedConfigPaths[variant]) {
      pathIssues.push(
        "The " +
          variant +
          " fixture matrix must use " +
          (variant === "broken" ? DEFAULT_BROKEN_FIXTURE_CONFIG : DEFAULT_FIXED_FIXTURE_CONFIG),
      );
    }
  }
  if (pathIssues.length > 0) throw new FixtureMatrixValidationError(pathIssues);
  await Promise.all([
    verifyRealWorkspacePath(input.root, input.manifestPath, "fixture matrix manifest"),
    verifyRealWorkspacePath(input.root, input.configPaths.broken, "broken fixture config"),
    verifyRealWorkspacePath(input.root, input.configPaths.fixed, "fixed fixture config"),
  ]);
  const manifestRelativePath = repositoryRelative(input.root, input.manifestPath, "fixture matrix manifest");
  const [loadedManifest, app, wallet, brokenConfig, fixedConfig] = await Promise.all([
    loadManifest(input.manifestPath),
    loadFixtureArtifactContract(input.root, CONTROLLED_DAPP_MANIFEST, "app"),
    loadFixtureArtifactContract(input.root, MOCK_MWA_MANIFEST, "wallet"),
    loadConfig(input.configPaths.broken),
    loadConfig(input.configPaths.fixed),
  ]);
  const matrixCase = selectExecutableCase(loadedManifest.manifest);
  const configs = { broken: brokenConfig, fixed: fixedConfig };
  const issues: string[] = [];
  for (const variant of EXECUTION_ORDER) {
    const appLink = app.deepLinks?.[variant];
    const matrixLink = matrixCase.expectations[variant].launchUri;
    if (appLink !== matrixLink) issues.push(variant + " launch URI differs between the app and matrix manifests");
    try {
      validateConfigContract({ root: input.root, config: configs[variant], variant, matrixCase, app, wallet });
    } catch (error) {
      if (error instanceof FixtureMatrixValidationError) issues.push(...error.issues);
      else throw error;
    }
  }
  if (issues.length > 0) throw new FixtureMatrixValidationError(issues);

  const variantEntries = await Promise.all(
    EXECUTION_ORDER.map(async (variant): Promise<[FixtureMatrixVariant, PreparedVariant]> => {
      const config = configs[variant];
      const scenario = config.scenarios[0];
      if (!scenario) throw new Error("Fixture matrix invariant failed: scenario was not found");
      const expectedLaunchUri = matrixCase.expectations[variant].launchUri;
      const [configSource, flow] = await Promise.all([
        readText(config.configPath, variant + " config"),
        inspectFlow(input.root, scenario.resolvedFlow, app.packageName, expectedLaunchUri, variant),
      ]);
      const expectation = matrixCase.expectations[variant];
      const configSha256 = sha256Text(configSource);
      if (configSha256 !== expectation.configSha256) {
        throw new FixtureMatrixValidationError([
          variant + " config SHA-256 differs from the controlled matrix manifest",
        ]);
      }
      if (flow.flowSha256 !== expectation.flowSha256) {
        throw new FixtureMatrixValidationError([
          variant + " flow SHA-256 differs from the controlled matrix manifest",
        ]);
      }
      const configPath = repositoryRelative(input.root, config.configPath, variant + " config");
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
  const normalizedBrokenFlow = variants.broken.flowSource.replace(
    matrixCase.expectations.broken.launchUri,
    "launchrig://fixture/rejection?variant=VARIANT",
  );
  const normalizedFixedFlow = variants.fixed.flowSource.replace(
    matrixCase.expectations.fixed.launchUri,
    "launchrig://fixture/rejection?variant=VARIANT",
  );
  if (normalizedBrokenFlow !== normalizedFixedFlow) {
    throw new FixtureMatrixValidationError([
      "Broken and fixed fixture flows must be identical except for the controlled variant URI",
    ]);
  }
  const [appProvenance, walletProvenance] = await Promise.all([
    verifyArtifact(input.root, app, "app"),
    verifyArtifact(input.root, wallet, "wallet"),
  ]);
  return {
    matrixCase,
    manifestPath: manifestRelativePath,
    manifestSha256: sha256Text(loadedManifest.source),
    artifacts: { app, wallet },
    variants,
    provenance: {
      app: appProvenance,
      wallet: walletProvenance,
      variants: {
        broken: variants.broken.provenance,
        fixed: variants.fixed.provenance,
      },
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

function publicRunOutput(
  root: string,
  output: RunOutput,
  variant: FixtureMatrixVariant,
  redactPatterns: string[],
): RunOutput {
  return {
    ...output,
    report: redactJsonValue(output.report, redactPatterns).value,
    artifacts: {
      ...output.artifacts,
      directory: repositoryRelative(root, output.artifacts.directory, variant + " artifact directory"),
      json: repositoryRelative(root, output.artifacts.json, variant + " JSON report"),
      html: repositoryRelative(root, output.artifacts.html, variant + " HTML report"),
      junit: repositoryRelative(root, output.artifacts.junit, variant + " JUnit report"),
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
  provenance: FixtureMatrixProvenance,
): string[] {
  const issues: string[] = [];
  const report = execution.output.report;
  const prefix = execution.variant + " report ";
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
  const configPaths: Record<FixtureMatrixVariant, string> = {
    broken: path.resolve(cwd, options.brokenConfigPath ?? DEFAULT_BROKEN_FIXTURE_CONFIG),
    fixed: path.resolve(cwd, options.fixedConfigPath ?? DEFAULT_FIXED_FIXTURE_CONFIG),
  };
  const preflight = await preflightFixtureMatrix({ root: cwd, manifestPath, configPaths });
  const projectRunner = options.projectRunner ?? runProject;
  const executions: FixtureMatrixExecution[] = [];

  for (const variant of EXECUTION_ORDER) {
    const prepared = preflight.variants[variant];
    const output = await projectRunner(
      prepared.config.configPath,
      projectRunOptions(options, preflight.matrixCase.scenarioId),
    );
    executions.push({
      caseId: preflight.matrixCase.id,
      scenarioId: preflight.matrixCase.scenarioId,
      variant,
      configPath: prepared.configPath,
      output: publicRunOutput(cwd, output, variant, prepared.config.privacy.redactPatterns),
    });
  }

  const setupError = executions.some(
    (execution) => execution.output.exitCode === 3 || execution.output.report.outcome === "setup-error",
  );
  if (!setupError) {
    const evidenceIssues = executions.flatMap((execution) =>
      validateExecutionEvidence(execution, preflight.variants[execution.variant], preflight.provenance),
    );
    if (evidenceIssues.length > 0) throw new FixtureMatrixValidationError(evidenceIssues);
  }

  await Promise.all([
    verifyArtifact(cwd, preflight.artifacts.app, "app"),
    verifyArtifact(cwd, preflight.artifacts.wallet, "wallet"),
  ]);

  const evaluation = evaluateFixtureMatrix(
    { schemaVersion: 1, cases: [preflight.matrixCase] },
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
