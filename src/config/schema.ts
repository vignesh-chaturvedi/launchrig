import type { LaunchRigConfig, ScenarioConfig } from "../types.js";

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super("LaunchRig configuration is invalid");
    this.name = "ConfigError";
    this.issues = issues;
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
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string, path: string, issues: string[]): string | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    issues.push(path + "." + key + " must be a string");
    return undefined;
  }
  return value.trim();
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
  path: string,
  issues: string[],
): "always" | "if-missing" {
  const value = record.installPolicy ?? "always";
  if (value !== "always" && value !== "if-missing") {
    issues.push(path + ".installPolicy must be always or if-missing");
    return "always";
  }
  return value;
}

function parseScenarios(value: unknown, issues: string[]): ScenarioConfig[] {
  if (!Array.isArray(value)) {
    issues.push("scenarios must be an array");
    return [];
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    const path = "scenarios[" + index + "]";
    const record = readRecord(entry, path, issues);
    rejectUnknownKeys(record, ["id", "kind", "name", "flow", "required", "timeoutMs"], path, issues);
    const id = requiredString(record, "id", path, issues);
    if (id && !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      issues.push(path + ".id must contain lowercase letters, numbers, or hyphens");
    }
    if (seen.has(id)) issues.push(path + ".id duplicates " + id);
    seen.add(id);
    const kind = record.kind;
    if (
      kind !== "mwa-authorize" &&
      kind !== "mwa-siws" &&
      kind !== "mwa-sign-message" &&
      kind !== "mwa-reject" &&
      kind !== "custom"
    ) {
      issues.push(path + ".kind must be a supported versioned scenario kind");
    }
    return {
      id,
      kind: kind as ScenarioConfig["kind"],
      name: requiredString(record, "name", path, issues),
      flow: requiredString(record, "flow", path, issues),
      required: booleanWithDefault(record, "required", true, path, issues),
      timeoutMs: integerWithDefault(record, "timeoutMs", 120000, 1000, 600000, path, issues),
    };
  });
}

export function validateConfig(value: unknown): LaunchRigConfig {
  const issues: string[] = [];
  const root = readRecord(value, "config", issues);
  rejectUnknownKeys(
    root,
    ["version", "project", "target", "device", "wallet", "scenarios", "artifacts", "privacy", "tooling"],
    "config",
    issues,
  );

  if (root.version !== 1) issues.push("version must be 1");

  const project = readRecord(root.project, "project", issues);
  rejectUnknownKeys(project, ["name", "packageName", "apk", "install", "installPolicy"], "project", issues);
  const packageName = requiredString(project, "packageName", "project", issues);
  if (packageName && !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
    issues.push("project.packageName is not a valid Android application ID");
  }
  const apk = optionalString(project, "apk", "project", issues);
  const install = booleanWithDefault(project, "install", false, "project", issues);
  const projectInstallPolicy = installPolicyWithDefault(project, "project", issues);
  if (install && !apk) issues.push("project.apk is required when project.install is true");

  const target = readRecord(root.target, "target", issues);
  rejectUnknownKeys(target, ["network"], "target", issues);
  const network = target.network;
  if (network !== "devnet" && network !== "testnet") {
    issues.push("target.network must be devnet or testnet; LaunchRig Phase 1 refuses mainnet");
  }
  if (
    packageName === "com.solana.mobilewalletadapter.fakedapp" &&
    network !== "testnet"
  ) {
    issues.push("the official MWA fakedapp fixture is hard-coded to testnet; target.network must be testnet");
  }

  const device = readRecord(root.device, "device", issues);
  rejectUnknownKeys(device, ["requirePhysical", "minimumApiLevel"], "device", issues);

  const wallet = readRecord(root.wallet, "wallet", issues);
  rejectUnknownKeys(wallet, ["mode", "packageName", "apk", "install", "installPolicy"], "wallet", issues);
  const walletMode = wallet.mode;
  if (walletMode !== "mock-mwa" && walletMode !== "reference-fakewallet" && walletMode !== "real") {
    issues.push("wallet.mode must be mock-mwa, reference-fakewallet, or real");
  }
  const walletPackageName = optionalString(wallet, "packageName", "wallet", issues);
  const walletApk = optionalString(wallet, "apk", "wallet", issues);
  const walletInstall = booleanWithDefault(wallet, "install", false, "wallet", issues);
  const walletInstallPolicy = installPolicyWithDefault(wallet, "wallet", issues);
  if (walletInstall && !walletApk) issues.push("wallet.apk is required when wallet.install is true");
  if (walletInstall && walletMode === "real") issues.push("LaunchRig will not install or replace a real wallet package");
  if (
    walletInstall &&
    walletPackageName !== "com.solana.mwallet" &&
    walletPackageName !== "com.solana.mobilewalletadapter.fakewallet"
  ) {
    issues.push("wallet.install is limited to an allowlisted Solana Mobile test-wallet package");
  }

  const artifacts = readRecord(root.artifacts, "artifacts", issues);
  rejectUnknownKeys(artifacts, ["directory", "screenshots", "retention"], "artifacts", issues);
  const screenshotMode = artifacts.screenshots ?? "failure";
  if (screenshotMode !== "failure" && screenshotMode !== "always" && screenshotMode !== "never") {
    issues.push("artifacts.screenshots must be failure, always, or never");
  }

  const privacy = readRecord(root.privacy, "privacy", issues);
  rejectUnknownKeys(privacy, ["includeLogcat", "logcatLines", "redactPatterns"], "privacy", issues);
  let redactPatterns: string[] = [];
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

  const tooling = root.tooling === undefined ? {} : readRecord(root.tooling, "tooling", issues);
  rejectUnknownKeys(tooling, ["adb", "maestro"], "tooling", issues);
  const adb = optionalString(tooling, "adb", "tooling", issues);
  const maestro = optionalString(tooling, "maestro", "tooling", issues);

  const scenarios = parseScenarios(root.scenarios, issues);

  if (issues.length > 0) throw new ConfigError(issues);

  const parsed: LaunchRigConfig = {
    version: 1,
    project: {
      name: requiredString(project, "name", "project", []),
      packageName,
      install,
      installPolicy: projectInstallPolicy,
      ...(apk ? { apk } : {}),
    },
    target: { network: network as "devnet" | "testnet" },
    device: {
      requirePhysical: booleanWithDefault(device, "requirePhysical", true, "device", []),
      minimumApiLevel: integerWithDefault(device, "minimumApiLevel", 26, 23, 100, "device", []),
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
      directory: requiredString(artifacts, "directory", "artifacts", []),
      screenshots: screenshotMode as "failure" | "always" | "never",
      retention: integerWithDefault(artifacts, "retention", 5, 1, 25, "artifacts", []),
    },
    privacy: {
      includeLogcat: booleanWithDefault(privacy, "includeLogcat", false, "privacy", []),
      logcatLines: integerWithDefault(privacy, "logcatLines", 200, 1, 1000, "privacy", []),
      redactPatterns,
    },
    tooling: {
      ...(adb ? { adb } : {}),
      ...(maestro ? { maestro } : {}),
    },
  };
  return parsed;
}
