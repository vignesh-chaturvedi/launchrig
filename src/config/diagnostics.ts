export const CONFIG_RULE_CHECK_IDS = Object.freeze({
  LR001: "config.schema",
  LR002: "config.network-safety",
  LR003: "config.wallet-safety",
  LR004: "config.privacy-safety",
  LR005: "config.input-files",
} as const);

export type ConfigRuleId = keyof typeof CONFIG_RULE_CHECK_IDS;
export type ConfigCheckId = (typeof CONFIG_RULE_CHECK_IDS)[ConfigRuleId];
export type ConfigRuleStatus = "passed" | "failed" | "not-evaluated";

export interface ConfigDiagnostic {
  ruleId: ConfigRuleId;
  checkId: ConfigCheckId;
  code: string;
  path: string;
  message: string;
}

export interface ConfigRuleResult {
  ruleId: ConfigRuleId;
  checkId: ConfigCheckId;
  status: ConfigRuleStatus;
  diagnosticCount: number;
}

export const CONFIG_RULE_IDS = Object.freeze(
  Object.keys(CONFIG_RULE_CHECK_IDS) as ConfigRuleId[],
);

export const SCHEMA_CONFIG_RULE_IDS = Object.freeze([
  "LR001",
  "LR002",
  "LR003",
  "LR004",
] as const satisfies readonly ConfigRuleId[]);

export function configDiagnostic(
  ruleId: ConfigRuleId,
  code: string,
  path: string,
  message: string,
): ConfigDiagnostic {
  const normalizedMessage = message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 4000);
  return {
    ruleId,
    checkId: CONFIG_RULE_CHECK_IDS[ruleId],
    code,
    path,
    message: normalizedMessage || "Configuration validation failed",
  };
}

export function configDiagnosticMessages(diagnostics: readonly ConfigDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.message);
}

function schemaPath(message: string): string {
  const match = /^(config(?:\.[A-Za-z0-9_-]+)?|version|project(?:\.[A-Za-z0-9_-]+)?|target(?:\.[A-Za-z0-9_-]+)?|device(?:\.[A-Za-z0-9_-]+)?|wallet(?:\.[A-Za-z0-9_-]+)?|scenarios(?:\[\d+\])?(?:\.[A-Za-z0-9_-]+)?|artifacts(?:\.[A-Za-z0-9_-]+)?|privacy(?:\.[A-Za-z0-9_-]+)?|tooling(?:\.[A-Za-z0-9_-]+)?)/.exec(
    message,
  );
  return match?.[1] ?? "config";
}

export function schemaConfigDiagnostic(message: string): ConfigDiagnostic {
  const path = schemaPath(message);
  if (
    message.startsWith("target.network ") ||
    message.startsWith("the official MWA fakedapp fixture ")
  ) {
    return configDiagnostic(
      "LR002",
      message.startsWith("the official")
        ? "config.network-safety.reference-fixture-network"
        : "config.network-safety.unsupported-network",
      "target.network",
      message,
    );
  }
  if (
    message.startsWith("wallet.mode ") ||
    message.startsWith("wallet.apk ") ||
    message.startsWith("wallet.install ") ||
    message.startsWith("wallet.packageName ") ||
    message.startsWith("LaunchRig will not install or replace a real wallet package")
  ) {
    const code = message.includes("automated wallet scenarios")
      ? "config.wallet-safety.real-wallet-automation"
      : message.includes("allowlisted")
        ? "config.wallet-safety.install-package"
        : message.includes("requires packageName")
          ? "config.wallet-safety.mode-package"
          : message.includes("required when an MWA scenario")
            ? "config.wallet-safety.mwa-package-required"
            : message.includes("will not install")
              ? "config.wallet-safety.real-wallet-install"
              : "config.wallet-safety.invalid-profile";
    return configDiagnostic("LR003", code, path.startsWith("wallet") ? path : "wallet", message);
  }
  if (
    message.startsWith("artifacts.screenshots ") ||
    message.startsWith("privacy.includeLogcat ") ||
    message.startsWith("privacy.logcatLines ") ||
    message.startsWith("privacy.redactPatterns ")
  ) {
    const code = message.startsWith("artifacts.screenshots")
      ? "config.privacy-safety.screenshot-policy"
      : message.startsWith("privacy.includeLogcat")
        ? "config.privacy-safety.logcat-policy"
        : message.startsWith("privacy.logcatLines")
          ? "config.privacy-safety.logcat-bound"
          : message.includes("invalid regular expression")
            ? "config.privacy-safety.invalid-redaction-pattern"
            : "config.privacy-safety.redaction-patterns";
    return configDiagnostic("LR004", code, path, message);
  }
  let code = "config.schema.invalid-field";
  if (message.endsWith(" must be an object")) code = "config.schema.expected-object";
  else if (message.endsWith(" is not supported")) code = "config.schema.unknown-key";
  else if (message.startsWith("version must be ")) code = "config.schema.version";
  else if (message.includes("Android application ID")) code = "config.schema.android-application-id";
  else if (message.includes("duplicates ")) code = "config.schema.duplicate-scenario-id";
  else if (message.includes("supported versioned scenario kind")) code = "config.schema.scenario-kind";
  else if (message.startsWith("scenarios must contain at most ")) code = "config.schema.scenario-limit";
  return configDiagnostic("LR001", code, path, message);
}

export function configRuleResults(
  diagnostics: readonly ConfigDiagnostic[],
  evaluatedRuleIds: readonly ConfigRuleId[],
): ConfigRuleResult[] {
  const evaluated = new Set<ConfigRuleId>(evaluatedRuleIds);
  return CONFIG_RULE_IDS.map((ruleId) => {
    const diagnosticCount = diagnostics.reduce(
      (count, diagnostic) => count + (diagnostic.ruleId === ruleId ? 1 : 0),
      0,
    );
    return {
      ruleId,
      checkId: CONFIG_RULE_CHECK_IDS[ruleId],
      status: !evaluated.has(ruleId)
        ? "not-evaluated"
        : diagnosticCount > 0
          ? "failed"
          : "passed",
      diagnosticCount,
    };
  });
}
