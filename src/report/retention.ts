import { lstat, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

const RUN_DIRECTORY = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{6}$/;

async function isLaunchRigRunDirectory(root: string, name: string): Promise<boolean> {
  if (!RUN_DIRECTORY.test(name)) return false;
  const directory = path.join(root, name);
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    const source = await readFile(path.join(directory, "launchrig-report.json"), "utf8");
    if (Buffer.byteLength(source, "utf8") > 2 * 1024 * 1024) return false;
    const report = JSON.parse(source) as Record<string, unknown>;
    return report.schemaVersion === 1 && report.runId === name;
  } catch {
    return false;
  }
}

export async function pruneReportDirectories(root: string, retention: number): Promise<string[]> {
  if (!Number.isSafeInteger(retention) || retention < 1 || retention > 25) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && (await isLaunchRigRunDirectory(root, entry.name))) candidates.push(entry.name);
  }
  const expired = candidates.sort((left, right) => right.localeCompare(left)).slice(retention);
  const removed: string[] = [];
  for (const name of expired) {
    try {
      await rm(path.join(root, name), { recursive: true });
      removed.push(name);
    } catch {
      // Retention is best-effort and never changes the result of the completed run.
    }
  }
  return removed;
}
