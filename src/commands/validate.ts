import path from "node:path";
import {
  configDiagnosticMessages,
  configRuleResults,
  type ConfigDiagnostic,
  type ConfigRuleResult,
} from "../config/diagnostics.js";
import { loadConfig, validateConfigPathDiagnostics } from "../config/load.js";
import { ConfigError } from "../config/schema.js";

export interface ValidationOutput {
  schemaVersion: 1;
  kind: "launchrig-config-validation-result";
  profile: "config-rules-v1";
  status: "pre-award-foundation";
  valid: boolean;
  configPath: string;
  project: string | null;
  packageName: string | null;
  scenarios: number | null;
  issues: string[];
  diagnostics: ConfigDiagnostic[];
  ruleResults: ConfigRuleResult[];
  grantMilestoneComplete: false;
}

export async function validateProject(configPath: string): Promise<ValidationOutput> {
  const absoluteConfigPath = path.resolve(configPath);
  try {
    const config = await loadConfig(absoluteConfigPath);
    const diagnostics = await validateConfigPathDiagnostics(config);
    const issues = configDiagnosticMessages(diagnostics);
    return {
      schemaVersion: 1,
      kind: "launchrig-config-validation-result",
      profile: "config-rules-v1",
      status: "pre-award-foundation",
      valid: diagnostics.length === 0,
      configPath: config.configPath,
      project: config.project.name,
      packageName: config.project.packageName,
      scenarios: config.scenarios.length,
      issues,
      diagnostics,
      ruleResults: configRuleResults(diagnostics, ["LR001", "LR002", "LR003", "LR004", "LR005"]),
      grantMilestoneComplete: false,
    };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    const diagnostics = error.diagnostics.map((diagnostic) => ({ ...diagnostic }));
    return {
      schemaVersion: 1,
      kind: "launchrig-config-validation-result",
      profile: "config-rules-v1",
      status: "pre-award-foundation",
      valid: false,
      configPath: absoluteConfigPath,
      project: null,
      packageName: null,
      scenarios: null,
      issues: configDiagnosticMessages(diagnostics),
      diagnostics,
      ruleResults: configRuleResults(diagnostics, error.evaluatedRuleIds),
      grantMilestoneComplete: false,
    };
  }
}
