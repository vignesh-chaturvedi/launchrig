import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { STARTER_CONFIG } from "../config/starter.js";

export interface InitOptions {
  cwd: string;
  force: boolean;
  projectName?: string;
  packageName?: string;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function flowTemplate(packageName: string, purpose: string): string {
  return [
    "# Template only: replace the TODO selector before adding this flow to launchrig.yml.",
    "# Purpose: " + purpose,
    "appId: " + packageName,
    "---",
    "- launchApp:",
    "    clearState: false",
    "- assertVisible: \"TODO: app-ready-selector\"",
    "",
  ].join("\n");
}

export async function initProject(options: InitOptions): Promise<string[]> {
  const configPath = path.join(options.cwd, "launchrig.yml");
  if ((await exists(configPath)) && !options.force) {
    throw new Error("launchrig.yml already exists. Use --force only if you intend to replace it.");
  }

  const projectName = options.projectName?.trim() || "My Solana Mobile App";
  const packageName = options.packageName?.trim() || "com.example.app";
  const config = STARTER_CONFIG.replace("My Solana Mobile App", projectName).replace("com.example.app", packageName);
  await writeFile(configPath, config, "utf8");

  const flowDirectory = path.join(options.cwd, "launchrig-flows");
  await mkdir(flowDirectory, { recursive: true });
  const flowPurposes: Record<string, string> = {
    "mwa-authorize.example.yaml": "cold authorize and cached reauthorization",
    "mwa-siws.example.yaml": "SIWS when the wallet advertises the capability",
    "mwa-sign-message.example.yaml": "message signing after Mock MWA authentication",
    "mwa-reject.example.yaml": "user rejection returns the dApp to a usable state",
  };
  for (const [filename, purpose] of Object.entries(flowPurposes)) {
    const flowPath = path.join(flowDirectory, filename);
    if (!(await exists(flowPath)) || options.force) {
      await writeFile(flowPath, flowTemplate(packageName, purpose), "utf8");
    }
  }

  const gitignorePath = path.join(options.cwd, ".gitignore");
  const gitignore = (await exists(gitignorePath)) ? await readFile(gitignorePath, "utf8") : "";
  if (!gitignore.split(/\r?\n/).includes(".launchrig/")) {
    await appendFile(gitignorePath, (gitignore && !gitignore.endsWith("\n") ? "\n" : "") + ".launchrig/\n", "utf8");
  }

  return [configPath, ...Object.keys(flowPurposes).map((filename) => path.join(flowDirectory, filename))];
}
