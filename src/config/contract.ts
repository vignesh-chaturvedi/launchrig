export const CONFIG_V1_VERSION = 1 as const;
export const CONFIG_V1_SCHEMA_ID = "https://launchrig.dev/schemas/launchrig-v1.schema.json";
export const CONFIG_V1_CONFORMANCE_PATH = "schemas/fixtures/launchrig-config-v1.conformance.json";

export const CONFIG_ROOT_KEYS = [
  "version",
  "project",
  "target",
  "device",
  "wallet",
  "scenarios",
  "artifacts",
  "privacy",
  "tooling",
] as const;

export const PROJECT_KEYS = ["name", "packageName", "apk", "install", "installPolicy"] as const;
export const TARGET_KEYS = ["network"] as const;
export const DEVICE_KEYS = ["requirePhysical", "minimumApiLevel"] as const;
export const WALLET_KEYS = ["mode", "packageName", "apk", "install", "installPolicy"] as const;
export const SCENARIO_KEYS = ["id", "kind", "name", "flow", "required", "timeoutMs"] as const;
export const ARTIFACT_KEYS = ["directory", "screenshots", "retention"] as const;
export const PRIVACY_KEYS = ["includeLogcat", "logcatLines", "redactPatterns"] as const;
export const TOOLING_KEYS = ["adb", "maestro"] as const;

export const CONFIG_NETWORKS = ["devnet", "testnet"] as const;
export const INSTALL_POLICIES = ["always", "if-missing"] as const;
export const WALLET_MODES = ["mock-mwa", "reference-fakewallet", "real"] as const;
export const SCREENSHOT_MODES = ["failure", "always", "never"] as const;
export const SCENARIO_KINDS = [
  "mwa-authorize",
  "mwa-siws",
  "mwa-sign-message",
  "mwa-reject",
  "mwa-stale-authorization",
  "mwa-process-death",
  "custom",
] as const;
export const MWA_SCENARIO_KINDS = Object.freeze(SCENARIO_KINDS.filter((kind) => kind.startsWith("mwa-")));

export const MOCK_MWA_PACKAGE = "com.solana.mwallet";
export const REFERENCE_FAKEWALLET_PACKAGE = "com.solana.mobilewalletadapter.fakewallet";
export const REFERENCE_FAKEDAPP_PACKAGE = "com.solana.mobilewalletadapter.fakedapp";
export const INSTALLABLE_TEST_WALLET_PACKAGES = [MOCK_MWA_PACKAGE, REFERENCE_FAKEWALLET_PACKAGE] as const;

export const ANDROID_APPLICATION_ID_PATTERN = "^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$";
export const SCENARIO_ID_PATTERN = "^(?!(?:none|selection)$)[a-z0-9][a-z0-9-]*$";

export const CONFIG_V1_DEFAULTS = Object.freeze({
  projectInstall: false,
  projectInstallPolicy: "always" as const,
  requirePhysical: true,
  minimumApiLevel: 26,
  walletInstall: false,
  walletInstallPolicy: "always" as const,
  scenarioRequired: true,
  scenarioTimeoutMs: 120000,
  screenshots: "failure" as const,
  retention: 5,
  includeLogcat: false,
  logcatLines: 200,
  redactPatterns: Object.freeze([] as string[]),
  tooling: Object.freeze({}),
});

export const CONFIG_V1_LIMITS = Object.freeze({
  minimumApiLevel: Object.freeze({ minimum: 23, maximum: 100 }),
  scenarioCount: Object.freeze({ maximum: 50 }),
  scenarioTimeoutMs: Object.freeze({ minimum: 1000, maximum: 600000 }),
  retention: Object.freeze({ minimum: 1, maximum: 25 }),
  logcatLines: Object.freeze({ minimum: 1, maximum: 1000 }),
});

export const CONFIG_V1_RUNTIME_EXTENSIONS = Object.freeze([
  Object.freeze({
    id: "unique-scenario-id",
    summary: "Every scenarios[].id value must be unique within the configuration.",
  }),
  Object.freeze({
    id: "ecmascript-redact-regexp",
    summary: "Every privacy.redactPatterns entry must compile as a JavaScript regular expression with gi flags.",
  }),
]);
