import type { LaunchRigConfig, ScenarioConfig } from "../types.js";
import {
  configDiagnostic,
  configDiagnosticMessages,
  type ConfigDiagnostic,
  type ConfigRuleId,
  schemaConfigDiagnostic,
  SCHEMA_CONFIG_RULE_IDS,
} from "./diagnostics.js";
import {
  ANDROID_APPLICATION_ID_PATTERN,
  ARTIFACT_KEYS,
  CONFIG_NETWORKS,
  CONFIG_ROOT_KEYS,
  CONFIG_V1_DEFAULTS,
  CONFIG_V1_LIMITS,
  CONFIG_V1_VERSION,
  DEVICE_KEYS,
  INSTALLABLE_TEST_WALLET_PACKAGES,
  INSTALL_POLICIES,
  MOCK_MWA_PACKAGE,
  MWA_SCENARIO_KINDS,
  PRIVACY_KEYS,
  PROJECT_KEYS,
  REFERENCE_FAKEDAPP_PACKAGE,
  REFERENCE_FAKEWALLET_PACKAGE,
  SCENARIO_ID_PATTERN,
  SCENARIO_KEYS,
  SCENARIO_KINDS,
  SCREENSHOT_MODES,
  TARGET_KEYS,
  TOOLING_KEYS,
  WALLET_KEYS,
  WALLET_MODES,
} from "./contract.js";

export class ConfigError extends Error {
  readonly issues: string[];
  readonly diagnostics: ConfigDiagnostic[];
  readonly evaluatedRuleIds: ConfigRuleId[];

  constructor(
    entries: readonly string[] | readonly ConfigDiagnostic[],
    evaluatedRuleIds: readonly ConfigRuleId[] = ["LR005"],
  ) {
    super("LaunchRig configuration is invalid");
    this.name = "ConfigError";
    this.diagnostics = entries.map((entry) =>
      typeof entry === "string"
        ? configDiagnostic("LR005", "config.input-files.invalid", "config", entry)
        : { ...entry },
    );
    this.issues = configDiagnosticMessages(this.diagnostics);
    this.evaluatedRuleIds = [...evaluatedRuleIds];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, path: string, issues: string[]): Record<string, unknown> {
  if (!isRecord(value)) {
    issues.push(path + " must be an object");
    return {};
  }
  return value;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) issues.push(path + "." + key + " is not supported");
  }
}

function requiredString(record: Record<string, unknown>, key: string, path: string, issues: string[]): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(path + "." + key + " must be a non-empty string");
    return "";
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, path: string, issues: string[]): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(path + "." + key + " must be a non-empty string when provided");
    return undefined;
  }
  return value;
}

function isAllowedString<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
): value is Values[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function booleanWithDefault(
  record: Record<string, unknown>,
  key: string,
  defaultValue: boolean,
  path: string,
  issues: string[],
): boolean {
  const value = record[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    issues.push(path + "." + key + " must be true or false");
    return defaultValue;
  }
  return value;
}

function integerWithDefault(
  record: Record<string, unknown>,
  key: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
  path: string,
  issues: string[],
): number {
  const value = record[key];
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    issues.push(path + "." + key + " must be an integer from " + minimum + " to " + maximum);
    return defaultValue;
  }
  return value as number;
}

function installPolicyWithDefault(
  record: Record<string, unknown>,
  defaultValue: "always" | "if-missing",
  path: string,
  issues: string[],
): "always" | "if-missing" {
  const value = record.installPolicy === undefined ? defaultValue : record.installPolicy;
  if (!isAllowedString(value, INSTALL_POLICIES)) {
    issues.push(path + ".installPolicy must be always or if-missing");
    return defaultValue;
  }
  return value;
}

function parseScenarios(value: unknown, issues: string[]): ScenarioConfig[] {
  if (!Array.isArray(value)) {
    issues.push("scenarios must be an array");
    return [];
  }
  if (value.length > CONFIG_V1_LIMITS.scenarioCount.maximum) {
    issues.push("scenarios must contain at most " + CONFIG_V1_LIMITS.scenarioCount.maximum + " entries");
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    const path = "scenarios[" + index + "]";
    const record = readRecord(entry, path, issues);
    rejectUnknownKeys(record, SCENARIO_KEYS, path, issues);
    const id = requiredString(record, "id", path, issues);
    if (
      id &&
      (!new RegExp(SCENARIO_ID_PATTERN).test(id) ||
        id.length > CONFIG_V1_LIMITS.scenarioId.maximumLength)
    ) {
      issues.push(
        path +
          ".id must contain at most " +
          CONFIG_V1_LIMITS.scenarioId.maximumLength +
          " lowercase letters, numbers, or hyphens and must not be none or selection",
      );
    }
    if (id && seen.has(id)) issues.push(path + ".id duplicates " + id);
    if (id) seen.add(id);
    const kindValue = record.kind;
    if (!isAllowedString(kindValue, SCENARIO_KINDS)) {
      issues.push(path + ".kind must be a supported versioned scenario kind");
    }
    const kind = isAllowedString(kindValue, SCENARIO_KINDS) ? kindValue : "custom";
    return {
      id,
      kind,
      name: requiredString(record, "name", path, issues),
      flow: requiredString(record, "flow", path, issues),
      required: booleanWithDefault(record, "required", CONFIG_V1_DEFAULTS.scenarioRequired, path, issues),
      timeoutMs: integerWithDefault(
        record,
        "timeoutMs",
        CONFIG_V1_DEFAULTS.scenarioTimeoutMs,
        CONFIG_V1_LIMITS.scenarioTimeoutMs.minimum,
        CONFIG_V1_LIMITS.scenarioTimeoutMs.maximum,
        path,
        issues,
      ),
    };
  });
}

export function validateConfig(value: unknown): LaunchRigConfig {
  const issues: string[] = [];
  const root = readRecord(value, "config", issues);
  rejectUnknownKeys(root, CONFIG_ROOT_KEYS, "config", issues);

  if (root.version !== CONFIG_V1_VERSION) issues.push("version must be " + CONFIG_V1_VERSION);

  const project = readRecord(root.project, "project", issues);
  rejectUnknownKeys(project, PROJECT_KEYS, "project", issues);
  const projectName = requiredString(project, "name", "project", issues);
  const packageName = requiredString(project, "packageName", "project", issues);
  if (packageName && !new RegExp(ANDROID_APPLICATION_ID_PATTERN).test(packageName)) {
    issues.push("project.packageName is not a valid Android application ID");
  }
  const apk = optionalString(project, "apk", "project", issues);
  const install = booleanWithDefault(project, "install", CONFIG_V1_DEFAULTS.projectInstall, "project", issues);
  const projectInstallPolicy = installPolicyWithDefault(
    project,
    CONFIG_V1_DEFAULTS.projectInstallPolicy,
    "project",
    issues,
  );
  if (install && !apk) issues.push("project.apk is required when project.install is true");

  const target = readRecord(root.target, "target", issues);
  rejectUnknownKeys(target, TARGET_KEYS, "target", issues);
  const network = target.network;
  if (!isAllowedString(network, CONFIG_NETWORKS)) {
    issues.push("target.network must be devnet or testnet; LaunchRig Phase 1 refuses mainnet");
  }
  if (packageName === REFERENCE_FAKEDAPP_PACKAGE && network !== "testnet") {
    issues.push("the official MWA fakedapp fixture is hard-coded to testnet; target.network must be testnet");
  }

  const device = readRecord(root.device, "device", issues);
  rejectUnknownKeys(device, DEVICE_KEYS, "device", issues);
  const requirePhysical = booleanWithDefault(
    device,
    "requirePhysical",
    CONFIG_V1_DEFAULTS.requirePhysical,
    "device",
    issues,
  );
  const minimumApiLevel = integerWithDefault(
    device,
    "minimumApiLevel",
    CONFIG_V1_DEFAULTS.minimumApiLevel,
    CONFIG_V1_LIMITS.minimumApiLevel.minimum,
    CONFIG_V1_LIMITS.minimumApiLevel.maximum,
    "device",
    issues,
  );

  const wallet = readRecord(root.wallet, "wallet", issues);
  rejectUnknownKeys(wallet, WALLET_KEYS, "wallet", issues);
  const walletMode = wallet.mode;
  if (!isAllowedString(walletMode, WALLET_MODES)) {
    issues.push("wallet.mode must be mock-mwa, reference-fakewallet, or real");
  }
  const walletPackageName = optionalString(wallet, "packageName", "wallet", issues);
  const walletApk = optionalString(wallet, "apk", "wallet", issues);
  const walletInstall = booleanWithDefault(wallet, "install", CONFIG_V1_DEFAULTS.walletInstall, "wallet", issues);
  const walletInstallPolicy = installPolicyWithDefault(
    wallet,
    CONFIG_V1_DEFAULTS.walletInstallPolicy,
    "wallet",
    issues,
  );
  if (walletMode === "mock-mwa" && walletPackageName !== MOCK_MWA_PACKAGE) {
    issues.push("wallet.mode mock-mwa requires packageName " + MOCK_MWA_PACKAGE);
  }
  if (walletMode === "reference-fakewallet" && walletPackageName !== REFERENCE_FAKEWALLET_PACKAGE) {
    issues.push("wallet.mode reference-fakewallet requires packageName " + REFERENCE_FAKEWALLET_PACKAGE);
  }
  if (walletInstall && !walletApk) issues.push("wallet.apk is required when wallet.install is true");
  if (walletInstall && walletMode === "real") issues.push("LaunchRig will not install or replace a real wallet package");
  if (walletInstall && !isAllowedString(walletPackageName, INSTALLABLE_TEST_WALLET_PACKAGES)) {
    issues.push("wallet.install is limited to an allowlisted Solana Mobile test-wallet package");
  }

  const artifacts = readRecord(root.artifacts, "artifacts", issues);
  rejectUnknownKeys(artifacts, ARTIFACT_KEYS, "artifacts", issues);
  const artifactDirectory = requiredString(artifacts, "directory", "artifacts", issues);
  const screenshotMode =
    artifacts.screenshots === undefined ? CONFIG_V1_DEFAULTS.screenshots : artifacts.screenshots;
  if (!isAllowedString(screenshotMode, SCREENSHOT_MODES)) {
    issues.push("artifacts.screenshots must be failure, always, or never");
  }
  const retention = integerWithDefault(
    artifacts,
    "retention",
    CONFIG_V1_DEFAULTS.retention,
    CONFIG_V1_LIMITS.retention.minimum,
    CONFIG_V1_LIMITS.retention.maximum,
    "artifacts",
    issues,
  );
  if (walletMode === "real" && screenshotMode !== "never") {
    issues.push("artifacts.screenshots must be never when wallet.mode is real");
  }

  const privacy = readRecord(root.privacy, "privacy", issues);
  rejectUnknownKeys(privacy, PRIVACY_KEYS, "privacy", issues);
  const includeLogcat = booleanWithDefault(
    privacy,
    "includeLogcat",
    CONFIG_V1_DEFAULTS.includeLogcat,
    "privacy",
    issues,
  );
  const logcatLines = integerWithDefault(
    privacy,
    "logcatLines",
    CONFIG_V1_DEFAULTS.logcatLines,
    CONFIG_V1_LIMITS.logcatLines.minimum,
    CONFIG_V1_LIMITS.logcatLines.maximum,
    "privacy",
    issues,
  );
  let redactPatterns: string[] = [...CONFIG_V1_DEFAULTS.redactPatterns];
  if (privacy.redactPatterns !== undefined) {
    if (!Array.isArray(privacy.redactPatterns) || privacy.redactPatterns.some((item) => typeof item !== "string")) {
      issues.push("privacy.redactPatterns must be an array of regular-expression strings");
    } else {
      redactPatterns = privacy.redactPatterns as string[];
      for (const pattern of redactPatterns) {
        try {
          void new RegExp(pattern, "gi");
        } catch {
          issues.push("privacy.redactPatterns contains an invalid regular expression: " + pattern);
        }
      }
    }
  }

  const tooling =
    root.tooling === undefined ? { ...CONFIG_V1_DEFAULTS.tooling } : readRecord(root.tooling, "tooling", issues);
  rejectUnknownKeys(tooling, TOOLING_KEYS, "tooling", issues);
  const adb = optionalString(tooling, "adb", "tooling", issues);
  const maestro = optionalString(tooling, "maestro", "tooling", issues);

  const scenarios = parseScenarios(root.scenarios, issues);
  if (walletMode === "real" && scenarios.length > 0) {
    issues.push("wallet.mode real supports package checks only; automated wallet scenarios are disabled");
  }
  if (walletMode === "real" && includeLogcat) {
    issues.push("privacy.includeLogcat must be false when wallet.mode is real");
  }
  if (scenarios.some((scenario) => isAllowedString(scenario.kind, MWA_SCENARIO_KINDS)) && !walletPackageName) {
    issues.push("wallet.packageName is required when an MWA scenario is configured");
  }

  if (issues.length > 0) {
    throw new ConfigError(
      issues.map((issue) => schemaConfigDiagnostic(issue)),
      SCHEMA_CONFIG_RULE_IDS,
    );
  }

  const parsed: LaunchRigConfig = {
    version: CONFIG_V1_VERSION,
    project: {
      name: projectName,
      packageName,
      install,
      installPolicy: projectInstallPolicy,
      ...(apk ? { apk } : {}),
    },
    target: { network: network as "devnet" | "testnet" },
    device: {
      requirePhysical,
      minimumApiLevel,
    },
    wallet: {
      mode: walletMode as "mock-mwa" | "reference-fakewallet" | "real",
      ...(walletPackageName ? { packageName: walletPackageName } : {}),
      ...(walletApk ? { apk: walletApk } : {}),
      install: walletInstall,
      installPolicy: walletInstallPolicy,
    },
    scenarios,
    artifacts: {
      directory: artifactDirectory,
      screenshots: screenshotMode as "failure" | "always" | "never",
      retention,
    },
    privacy: {
      includeLogcat,
      logcatLines,
      redactPatterns,
    },
    tooling: {
      ...(adb ? { adb } : {}),
      ...(maestro ? { maestro } : {}),
    },
  };
  return parsed;
}
