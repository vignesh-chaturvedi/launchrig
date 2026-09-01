import { createHash } from "node:crypto";
import { CONFIG_RULE_CHECK_IDS } from "../config/diagnostics.js";

export const RUN_CHECK_IDS = Object.freeze({
  adb: "tool.adb",
  deviceConnected: "device.connected",
  deviceApi: "device.api",
  appInstall: "app.install",
  appInstalled: "app.installed",
  appBinary: "app.binary",
  walletInstall: "wallet.install",
  walletInstalled: "wallet.installed",
  walletBinary: "wallet.binary",
  scenarioSelection: "scenario.selection",
  scenarioNone: "scenario.none",
  maestro: "tool.maestro",
  scenario: "scenario.*",
} as const);

export const PILOT_PREFLIGHT_CHECK_IDS = Object.freeze({
  state: "pilot.state",
  project: "pilot.project",
  wallet: "pilot.wallet",
  devicePolicy: "pilot.device-policy",
  flows: "pilot.flows",
  mwaCoverage: "pilot.mwa-coverage",
  environment: "pilot.environment",
} as const);

export type RunCheckId = (typeof RUN_CHECK_IDS)[keyof typeof RUN_CHECK_IDS];
export type PilotPreflightCheckId =
  (typeof PILOT_PREFLIGHT_CHECK_IDS)[keyof typeof PILOT_PREFLIGHT_CHECK_IDS];

export function scenarioCheckId(scenarioId: string): string {
  return "scenario." + scenarioId;
}

export type CoreRuleDomain = "configuration" | "runtime" | "pilot";
export type CoreRuleRequirement = "always" | "conditional";
export type CoreRuleResultKind = "validation-issue" | "report-check" | "preflight-check";

export interface CoreRuleDefinition {
  ruleId: string;
  checkId: string;
  domain: CoreRuleDomain;
  title: string;
  description: string;
  requirement: CoreRuleRequirement;
  resultKind: CoreRuleResultKind;
  implementation: string;
  testContract: string;
}

export interface CoreRuleCatalog {
  schemaVersion: 1;
  kind: "launchrig-core-rule-catalog";
  catalogVersion: 1;
  status: "pre-award-foundation";
  ruleCount: 25;
  rules: CoreRuleDefinition[];
  catalogSha256: string;
  grantMilestoneComplete: false;
  limitations: string[];
}

const CONFIGURATION_RULES: readonly CoreRuleDefinition[] = [
  {
    ruleId: "LR001",
    checkId: CONFIG_RULE_CHECK_IDS.LR001,
    domain: "configuration",
    title: "Versioned configuration shape",
    description: "Requires launchrig.yml version 1, supported fields, typed values, and valid Android identifiers.",
    requirement: "always",
    resultKind: "validation-issue",
    implementation: "src/config/schema.ts#validateConfig",
    testContract: "test/config-rule-results.test.ts",
  },
  {
    ruleId: "LR002",
    checkId: CONFIG_RULE_CHECK_IDS.LR002,
    domain: "configuration",
    title: "Non-mainnet network safety",
    description: "Allows only devnet or testnet and binds the official reference dApp fixture to testnet.",
    requirement: "always",
    resultKind: "validation-issue",
    implementation: "src/config/schema.ts#validateConfig",
    testContract: "test/config-rule-results.test.ts",
  },
  {
    ruleId: "LR003",
    checkId: CONFIG_RULE_CHECK_IDS.LR003,
    domain: "configuration",
    title: "Wallet profile and install boundary",
    description: "Binds test-wallet modes to approved packages and refuses installation or automation of real wallets.",
    requirement: "always",
    resultKind: "validation-issue",
    implementation: "src/config/schema.ts#validateConfig",
    testContract: "test/config-rule-results.test.ts",
  },
  {
    ruleId: "LR004",
    checkId: CONFIG_RULE_CHECK_IDS.LR004,
    domain: "configuration",
    title: "Privacy-safe evidence configuration",
    description: "Validates redaction patterns and disables screenshots, logcat, and scenarios for real-wallet profiles.",
    requirement: "always",
    resultKind: "validation-issue",
    implementation: "src/config/schema.ts#validateConfig",
    testContract: "test/config-rule-results.test.ts",
  },
  {
    ruleId: "LR005",
    checkId: CONFIG_RULE_CHECK_IDS.LR005,
    domain: "configuration",
    title: "Safe artifact and flow inputs",
    description: "Requires regular bounded input files and policy-limited Maestro flow definitions.",
    requirement: "conditional",
    resultKind: "validation-issue",
    implementation: "src/config/load.ts#validateConfigPathDiagnostics",
    testContract: "test/config-rule-results.test.ts",
  },
];

const RUNTIME_RULES: readonly CoreRuleDefinition[] = [
  {
    ruleId: "LR006",
    checkId: RUN_CHECK_IDS.adb,
    domain: "runtime",
    title: "ADB available",
    description: "Finds and invokes Android Debug Bridge before any device operation.",
    requirement: "always",
    resultKind: "report-check",
    implementation: "src/runner/orchestrator.ts#runLaunchRig",
    testContract: "test/runtime-rule-results.test.ts",
  },
  {
    ruleId: "LR007",
    checkId: RUN_CHECK_IDS.deviceConnected,
    domain: "runtime",
    title: "Authorized physical Android device",
    description: "Selects exactly one authorized device and enforces the configured physical-device policy.",
    requirement: "always",
    resultKind: "report-check",
    implementation: "src/runner/orchestrator.ts#runLaunchRig",
    testContract: "test/runtime-rule-results.test.ts",
  },
  {
    ruleId: "LR008",
    checkId: RUN_CHECK_IDS.deviceApi,
    domain: "runtime",
    title: "Android API compatibility",
    description: "Compares the connected device API level with the configured minimum.",
    requirement: "always",
    resultKind: "report-check",
    implementation: "src/runner/orchestrator.ts#runLaunchRig",
    testContract: "test/runtime-rule-results.test.ts",
  },
  {
    ruleId: "LR009",
    checkId: RUN_CHECK_IDS.appInstall,
    domain: "runtime",
    title: "App installation",
    description: "Installs or safely skips the configured app APK without clearing app data.",
    requirement: "conditional",
    resultKind: "report-check",
    implementation: "src/runner/orchestrator.ts#runLaunchRig",
    testContract: "test/runtime-rule-results.test.ts",
  },
  {
    ruleId: "LR010",
    checkId: RUN_CHECK_IDS.appInstalled,
    domain: "runtime",
    title: "App package present",
    description: "Requires the configured application package to be installed on the selected device.",
    requirement: "always",
    resultKind: "report-check",
    implementation: "src/runner/orchestrator.ts#runLaunchRig",
    testContract: "test/runtime-rule-results.test.ts",
  },
  {
    ruleId: "LR011",
    checkId: RUN_CHECK_IDS.appBinary,
    domain: "runtime",
    title: "App binary identity",
    description: "Binds the installed app binary to the configured APK when exact artifact verification is requested.",
    requirement: "conditional",
    resultKind: "report-check",
    implementation: "src/runner/orchestrator.ts#runLaunchRig",
    testContract: "test/runtime-rule-results.test.ts",
  },
  {
    ruleId: "LR012",
    checkId: RUN_CHECK_IDS.walletInstall,
    domain: "runtime",
    title: "Managed wallet installation",
    description: "Installs only a hash-pinned allowlisted test wallet and preserves wallet data.",
    requirement: "conditional",
    resultKind: "report-check",
    implementation: "src/runner/orchestrator.ts#runLaunchRig",
    testContract: "test/runtime-rule-results.test.ts",
  },
  {
    ruleId: "LR013",
    checkId: RUN_CHECK_IDS.walletInstalled,
    domain: "runtime",
    title: "Wallet package present",
    description: "Requires the configured wallet package when the selected profile uses one.",
    requirement: "conditional",
    resultKind: "report-check",
    implementation: "src/runner/orchestrator.ts#runLaunchRig",
    testContract: "test/runtime-rule-results.test.ts",
  },
  {
    ruleId: "LR014",
    checkId: RUN_CHECK_IDS.walletBinary,
    domain: "runtime",
    title: "Wallet binary identity",
    description: "Binds an installed managed test wallet to its tracked SHA-256 contract.",
    requirement: "conditional",
    resultKind: "report-check",
    implementation: "src/runner/orchestrator.ts#runLaunchRig",
    testContract: "test/runtime-rule-results.test.ts",
  },
  {
    ruleId: "LR015",
    checkId: RUN_CHECK_IDS.scenarioSelection,
    domain: "runtime",
    title: "Scenario selection",
    description: "Records a valid requested scenario and refuses an ID that is absent from the validated configuration.",
    requirement: "conditional",
    resultKind: "report-check",
    implementation: "src/runner/orchestrator.ts#runLaunchRig",
    testContract: "test/runtime-rule-results.test.ts",
  },
  {
    ruleId: "LR016",
    checkId: RUN_CHECK_IDS.scenarioNone,
    domain: "runtime",
    title: "Device-only run boundary",
    description: "Records a non-wallet device-only result when no UI scenarios are configured.",
    requirement: "conditional",
    resultKind: "report-check",
    implementation: "src/runner/orchestrator.ts#runLaunchRig",
    testContract: "test/runtime-rule-results.test.ts",
  },
  {
    ruleId: "LR017",
    checkId: RUN_CHECK_IDS.maestro,
    domain: "runtime",
    title: "Maestro available",
    description: "Requires a supported Maestro executable before running configured UI scenarios.",
    requirement: "conditional",
    resultKind: "report-check",
    implementation: "src/runner/orchestrator.ts#runLaunchRig",
    testContract: "test/runtime-rule-results.test.ts",
  },
  {
    ruleId: "LR018",
    checkId: RUN_CHECK_IDS.scenario,
    domain: "runtime",
    title: "Publisher scenario result",
    description: "Emits one policy-limited, timeout-bounded result for each selected publisher scenario.",
    requirement: "conditional",
    resultKind: "report-check",
    implementation: "src/runner/orchestrator.ts#runLaunchRig",
    testContract: "test/runtime-rule-results.test.ts",
  },
];

const PILOT_RULES: readonly CoreRuleDefinition[] = [
  {
    ruleId: "LR019",
    checkId: PILOT_PREFLIGHT_CHECK_IDS.state,
    domain: "pilot",
    title: "Pilot state integrity",
    description: "Requires an existing private pilot record whose stored integrity digest recomputes.",
    requirement: "always",
    resultKind: "preflight-check",
    implementation: "src/commands/pilot.ts#checkPilot",
    testContract: "test/pilot.test.ts",
  },
  {
    ruleId: "LR020",
    checkId: PILOT_PREFLIGHT_CHECK_IDS.project,
    domain: "pilot",
    title: "External project boundary",
    description: "Refuses controlled fixtures and unchanged generated identities as publisher pilot projects.",
    requirement: "always",
    resultKind: "preflight-check",
    implementation: "src/commands/pilot.ts#checkPilot",
    testContract: "test/pilot.test.ts",
  },
  {
    ruleId: "LR021",
    checkId: PILOT_PREFLIGHT_CHECK_IDS.wallet,
    domain: "pilot",
    title: "Pilot wallet boundary",
    description: "Restricts pilot automation to an allowlisted development-wallet profile.",
    requirement: "always",
    resultKind: "preflight-check",
    implementation: "src/commands/pilot.ts#checkPilot",
    testContract: "test/pilot.test.ts",
  },
  {
    ruleId: "LR022",
    checkId: PILOT_PREFLIGHT_CHECK_IDS.devicePolicy,
    domain: "pilot",
    title: "Physical-device pilot policy",
    description: "Requires publisher pilot configuration to demand a physical Android device.",
    requirement: "always",
    resultKind: "preflight-check",
    implementation: "src/commands/pilot.ts#checkPilot",
    testContract: "test/pilot.test.ts",
  },
  {
    ruleId: "LR023",
    checkId: PILOT_PREFLIGHT_CHECK_IDS.flows,
    domain: "pilot",
    title: "Promoted publisher flows",
    description: "Refuses generated templates, reserved selectors, and unsafe publisher flow definitions.",
    requirement: "always",
    resultKind: "preflight-check",
    implementation: "src/commands/pilot.ts#checkPilot",
    testContract: "test/pilot.test.ts",
  },
  {
    ruleId: "LR024",
    checkId: PILOT_PREFLIGHT_CHECK_IDS.mwaCoverage,
    domain: "pilot",
    title: "Distinct core MWA coverage",
    description: "Requires four distinct promoted definitions for authorize, SIWS, sign-message, and rejection.",
    requirement: "always",
    resultKind: "preflight-check",
    implementation: "src/commands/pilot.ts#checkPilot",
    testContract: "test/pilot.test.ts",
  },
  {
    ruleId: "LR025",
    checkId: PILOT_PREFLIGHT_CHECK_IDS.environment,
    domain: "pilot",
    title: "Publisher environment readiness",
    description: "Checks the physical device, tool versions, installed packages, and exact configured binaries.",
    requirement: "conditional",
    resultKind: "preflight-check",
    implementation: "src/commands/pilot.ts#checkPilot",
    testContract: "test/pilot.test.ts",
  },
];

const RULES = Object.freeze([...CONFIGURATION_RULES, ...RUNTIME_RULES, ...PILOT_RULES]);
const LIMITATIONS = Object.freeze([
  "The catalog versions existing local checks; it does not prove any external publisher execution.",
  "Local executable fixtures have not been reviewed or released as the later public failure-fixture corpus.",
  "The catalog does not establish Seeker, production-wallet, Seed Vault, confirmed-defect, grant-award, or grant-readiness claims.",
]);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map((entry) => canonicalJson(entry)).join(",") + "]";
  if (typeof value !== "object") throw new Error("Rule catalog contains an unsupported value");
  const record = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]))
      .join(",") +
    "}"
  );
}

function assertCatalogDefinitions(rules: readonly CoreRuleDefinition[]): void {
  if (rules.length !== 25) throw new Error("LaunchRig core rule catalog must contain exactly 25 rules");
  const ruleIds = new Set<string>();
  const checkIds = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    const expectedRuleId = "LR" + String(index + 1).padStart(3, "0");
    if (rule.ruleId !== expectedRuleId) throw new Error("LaunchRig core rule IDs must be contiguous");
    if (ruleIds.has(rule.ruleId)) throw new Error("LaunchRig core rule IDs must be unique");
    if (checkIds.has(rule.checkId)) throw new Error("LaunchRig core check IDs must be unique");
    for (const value of [
      rule.checkId,
      rule.title,
      rule.description,
      rule.implementation,
      rule.testContract,
    ]) {
      if (value.length === 0 || value.length > 240) throw new Error("LaunchRig core rule text is invalid");
    }
    ruleIds.add(rule.ruleId);
    checkIds.add(rule.checkId);
  }
  for (const checkId of Object.values(RUN_CHECK_IDS)) {
    if (!checkIds.has(checkId)) throw new Error("Runtime check is missing from the core rule catalog: " + checkId);
  }
  for (const checkId of Object.values(PILOT_PREFLIGHT_CHECK_IDS)) {
    if (!checkIds.has(checkId)) throw new Error("Pilot check is missing from the core rule catalog: " + checkId);
  }
}

assertCatalogDefinitions(RULES);

const CATALOG_CORE = Object.freeze({
  schemaVersion: 1 as const,
  kind: "launchrig-core-rule-catalog" as const,
  catalogVersion: 1 as const,
  status: "pre-award-foundation" as const,
  ruleCount: 25 as const,
  rules: RULES,
  grantMilestoneComplete: false as const,
  limitations: LIMITATIONS,
});

const CATALOG_SHA256 = createHash("sha256").update(canonicalJson(CATALOG_CORE)).digest("hex");

export function getCoreRuleCatalog(): CoreRuleCatalog {
  return {
    schemaVersion: CATALOG_CORE.schemaVersion,
    kind: CATALOG_CORE.kind,
    catalogVersion: CATALOG_CORE.catalogVersion,
    status: CATALOG_CORE.status,
    ruleCount: CATALOG_CORE.ruleCount,
    rules: CATALOG_CORE.rules.map((rule) => ({ ...rule })),
    catalogSha256: CATALOG_SHA256,
    grantMilestoneComplete: CATALOG_CORE.grantMilestoneComplete,
    limitations: [...CATALOG_CORE.limitations],
  };
}
