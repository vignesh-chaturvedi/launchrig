import { constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findExecutable(
  name: string,
  explicit: string | undefined,
  extraCandidates: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const candidates: string[] = [];
  if (explicit) {
    if (path.isAbsolute(explicit) || explicit.includes(path.sep)) candidates.push(path.resolve(explicit));
    else candidates.push(explicit);
  }

  const executableNames = process.platform === "win32" ? [name + ".exe", name + ".cmd", name] : [name];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const executableName of executableNames) candidates.push(path.join(directory, executableName));
  }
  candidates.push(...extraCandidates);

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function adbCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [
    "/opt/homebrew/share/android-commandlinetools/platform-tools/adb",
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
  ];
  for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (sdk) candidates.push(path.join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb"));
  }
  candidates.push(path.join(os.homedir(), "Library", "Android", "sdk", "platform-tools", "adb"));
  return candidates;
}

export function maestroCandidates(): string[] {
  return [
    path.join(os.homedir(), ".maestro", "bin", "maestro"),
    "/opt/homebrew/bin/maestro",
    "/usr/local/bin/maestro",
  ];
}
