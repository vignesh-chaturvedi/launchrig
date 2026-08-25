import { loadConfig, validateConfigPaths } from "../config/load.js";

export interface ValidationOutput {
  valid: boolean;
  configPath: string;
  project: string;
  packageName: string;
  scenarios: number;
  issues: string[];
}

export async function validateProject(configPath: string): Promise<ValidationOutput> {
  const config = await loadConfig(configPath);
  const issues = await validateConfigPaths(config);
  return {
    valid: issues.length === 0,
    configPath: config.configPath,
    project: config.project.name,
    packageName: config.project.packageName,
    scenarios: config.scenarios.length,
    issues,
  };
}
