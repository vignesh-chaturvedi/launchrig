import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "fixtures", "mwa-v2.2.0.json"), "utf8"));
const outputDirectory = path.join(root, ".launchrig", "cache", "apks");
await mkdir(outputDirectory, { recursive: true });

for (const fixture of manifest.fixtures) {
  const target = path.join(outputDirectory, fixture.name);
  let existing;
  try {
    existing = await readFile(target);
  } catch {
    existing = undefined;
  }
  if (existing && createHash("sha256").update(existing).digest("hex") === fixture.sha256) {
    console.log("verified " + fixture.name);
    continue;
  }

  const response = await fetch(fixture.url, { redirect: "follow" });
  if (!response.ok) throw new Error("Download failed for " + fixture.name + ": HTTP " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== fixture.size) throw new Error("Size mismatch for " + fixture.name);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== fixture.sha256) throw new Error("SHA-256 mismatch for " + fixture.name);
  const temporary = target + ".part";
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  console.log("downloaded and verified " + fixture.name);
}
