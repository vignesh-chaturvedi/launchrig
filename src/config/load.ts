import path from "node:path";
import { parse } from "yaml";
import type { ResolvedLaunchRigConfig } from "../types.js";
import { isRegularFileNoFollow, readBoundedUtf8File } from "../security/file.js";
import { validateMaestroFlowSafety } from "../security/flow.js";
import { ConfigError, validateConfig } from "./schema.js";

export async function loadConfig(configPath: string): Promise<ResolvedLaunchRigConfig> {
  const absolutePath = path.resolve(configPath);
  let source: string;
  try {
    source = await readBoundedUtf8File(absolutePath, 1024 * 1024);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(["Cannot read " + absolutePath + ": " + message]);
  }

  let raw: unknown;
  try {
    raw = parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(["YAML parsing failed: " + message]);
  }

  const config = validateConfig(raw);
  const configDirectory = path.dirname(absolutePath);
  return {
    ...config,
    configPath: absolutePath,
    configDirectory,
    ...(config.project.apk ? { resolvedApk: path.resolve(configDirectory, config.project.apk) } : {}),
    ...(config.wallet.apk ? { resolvedWalletApk: path.resolve(configDirectory, config.wallet.apk) } : {}),
    resolvedArtifactDirectory: path.resolve(configDirectory, config.artifacts.directory),
    scenarios: config.scenarios.map((scenario) => ({
      ...scenario,
      resolvedFlow: path.resolve(configDirectory, scenario.flow),
    })),
  };
}

export async function validateConfigPaths(config: ResolvedLaunchRigConfig): Promise<string[]> {
  const issues: string[] = [];
  if (config.resolvedApk) {
    if (!(await isRegularFileNoFollow(config.resolvedApk))) {
      issues.push("APK is missing or is not a regular file: " + config.resolvedApk);
    }
  }
  if (config.resolvedWalletApk) {
    if (!(await isRegularFileNoFollow(config.resolvedWalletApk))) {
      issues.push("Wallet fixture APK is missing or is not a regular file: " + config.resolvedWalletApk);
    }
  }
  for (const scenario of config.scenarios) {
    try {
      const source = await readBoundedUtf8File(scenario.resolvedFlow, 512 * 1024);
      for (const issue of validateMaestroFlowSafety(source, config.project.packageName)) {
        issues.push("Scenario " + scenario.id + " " + issue);
      }
    } catch {
      issues.push("Scenario flow cannot be read safely: " + scenario.resolvedFlow);
    }
  }
  return issues;
}
