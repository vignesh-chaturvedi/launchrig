import { loadConfig, validateConfigPaths } from "../config/load.js";
import { ConfigError } from "../config/schema.js";
import { runLaunchRig, type RunOptions, type RunOutput } from "../runner/orchestrator.js";

export async function runProject(configPath: string, options: RunOptions = {}): Promise<RunOutput> {
  const config = await loadConfig(configPath);
  const issues = await validateConfigPaths(config);
  if (issues.length > 0) throw new ConfigError(issues);
  return await runLaunchRig(config, options);
}
