import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { ResolvedLaunchRigConfig } from "../types.js";
import { ConfigError, validateConfig } from "./schema.js";

export async function loadConfig(configPath: string): Promise<ResolvedLaunchRigConfig> {
  const absolutePath = path.resolve(configPath);
  let source: string;
  try {
    source = await readFile(absolutePath, "utf8");
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
  if (config.project.install && config.resolvedApk) {
    try {
      await access(config.resolvedApk);
    } catch {
      issues.push("APK does not exist: " + config.resolvedApk);
    }
  }
  if (config.wallet.install && config.resolvedWalletApk) {
    try {
      await access(config.resolvedWalletApk);
    } catch {
      issues.push("Wallet fixture APK does not exist: " + config.resolvedWalletApk);
    }
  }
  for (const scenario of config.scenarios) {
    try {
      await access(scenario.resolvedFlow);
    } catch {
      issues.push("Scenario flow does not exist: " + scenario.resolvedFlow);
    }
  }
  return issues;
}
