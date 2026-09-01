import { createHash } from "node:crypto";
import path from "node:path";
import { parse } from "yaml";
import type { ResolvedLaunchRigConfig } from "../types.js";
import { isRegularFileNoFollow, readBoundedRegularFile, readBoundedUtf8File } from "../security/file.js";
import { validateMaestroFlowSafety } from "../security/flow.js";
import { ConfigError, validateConfig } from "./schema.js";
import {
  configDiagnostic,
  configDiagnosticMessages,
  type ConfigDiagnostic,
} from "./diagnostics.js";

export interface LaunchRigConfigSnapshot {
  config: ResolvedLaunchRigConfig;
  sourceSha256: string;
  sizeBytes: number;
}

function resolveConfigSource(absolutePath: string, source: string): ResolvedLaunchRigConfig {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch {
    throw new ConfigError(
      [
        configDiagnostic(
          "LR001",
          "config.schema.yaml-invalid",
          "config",
          "Configuration YAML cannot be parsed",
        ),
      ],
      ["LR001"],
    );
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

export async function loadConfigSnapshot(configPath: string): Promise<LaunchRigConfigSnapshot> {
  const absolutePath = path.resolve(configPath);
  let bytes: Buffer;
  try {
    bytes = await readBoundedRegularFile(absolutePath, 1024 * 1024);
  } catch {
    throw new ConfigError(
      [
        configDiagnostic(
          "LR001",
          "config.schema.source-unreadable",
          "config",
          "Cannot read configuration safely",
        ),
      ],
      ["LR001"],
    );
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigError(
      [
        configDiagnostic(
          "LR001",
          "config.schema.invalid-utf8",
          "config",
          "Configuration must use valid UTF-8",
        ),
      ],
      ["LR001"],
    );
  }
  return {
    config: resolveConfigSource(absolutePath, source),
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };
}

export async function loadConfig(configPath: string): Promise<ResolvedLaunchRigConfig> {
  return (await loadConfigSnapshot(configPath)).config;
}

export async function validateConfigPathDiagnostics(
  config: ResolvedLaunchRigConfig,
): Promise<ConfigDiagnostic[]> {
  const diagnostics: ConfigDiagnostic[] = [];
  if (config.resolvedApk) {
    if (!(await isRegularFileNoFollow(config.resolvedApk))) {
      diagnostics.push(
        configDiagnostic(
          "LR005",
          "config.input-files.project-apk-unavailable",
          "project.apk",
          "APK is missing or is not a regular file",
        ),
      );
    }
  }
  if (config.resolvedWalletApk) {
    if (!(await isRegularFileNoFollow(config.resolvedWalletApk))) {
      diagnostics.push(
        configDiagnostic(
          "LR005",
          "config.input-files.wallet-apk-unavailable",
          "wallet.apk",
          "Wallet fixture APK is missing or is not a regular file",
        ),
      );
    }
  }
  for (const [index, scenario] of config.scenarios.entries()) {
    try {
      const source = await readBoundedUtf8File(scenario.resolvedFlow, 512 * 1024);
      for (const issue of validateMaestroFlowSafety(source, config.project.packageName)) {
        diagnostics.push(
          configDiagnostic(
            "LR005",
            "config.input-files.unsafe-flow",
            "scenarios[" + index + "].flow",
            "Scenario " + scenario.id + " " + issue,
          ),
        );
      }
    } catch {
      diagnostics.push(
        configDiagnostic(
          "LR005",
          "config.input-files.flow-unavailable",
          "scenarios[" + index + "].flow",
          "Scenario " + scenario.id + " flow cannot be read safely",
        ),
      );
    }
  }
  return diagnostics;
}

export async function validateConfigPaths(config: ResolvedLaunchRigConfig): Promise<string[]> {
  return configDiagnosticMessages(await validateConfigPathDiagnostics(config));
}
