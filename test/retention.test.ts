import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pruneReportDirectories } from "../src/report/retention.js";

async function writeRun(root: string, runId: string): Promise<void> {
  const directory = path.join(root, runId);
  await mkdir(directory);
  await writeFile(
    path.join(directory, "launchrig-report.json"),
    JSON.stringify({ schemaVersion: 1, runId }) + "\n",
    "utf8",
  );
}

test("retention removes only verified old LaunchRig run directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "launchrig-retention-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "launchrig-retention-outside-"));
  try {
    const oldest = "2026-08-26T10-00-00-000Z-000001";
    const middle = "2026-08-26T11-00-00-000Z-000002";
    const newest = "2026-08-26T12-00-00-000Z-000003";
    await writeRun(root, oldest);
    await writeRun(root, middle);
    await writeRun(root, newest);
    const unrelated = "2026-08-26T09-00-00-000Z-000000";
    await mkdir(path.join(root, unrelated));
    await writeFile(path.join(root, unrelated, "notes.txt"), "keep", "utf8");
    const outsideFile = path.join(outside, "sentinel.txt");
    await writeFile(outsideFile, "sentinel", "utf8");
    await symlink(outside, path.join(root, "2026-08-26T08-00-00-000Z-000004"));

    assert.deepEqual(await pruneReportDirectories(root, 2), [oldest]);
    await assert.rejects(() => access(path.join(root, oldest)));
    await access(path.join(root, middle));
    await access(path.join(root, newest));
    assert.equal(await readFile(path.join(root, unrelated, "notes.txt"), "utf8"), "keep");
    assert.equal(await readFile(outsideFile, "utf8"), "sentinel");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
