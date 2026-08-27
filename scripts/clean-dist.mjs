import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "dist");

try {
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Refusing to clean dist because it is not a real directory.");
  }
  const resolvedRoot = await realpath(root);
  const resolvedTarget = await realpath(target);
  if (resolvedTarget !== path.join(resolvedRoot, "dist")) {
    throw new Error("Refusing to clean dist outside the LaunchRig source root.");
  }
  await rm(target, { recursive: true, force: false });
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
