import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

export const YAML_RUNTIME_NAME = "yaml";
export const YAML_RUNTIME_VERSION = "2.9.0";
export const YAML_RUNTIME_LICENSE = "ISC";
export const YAML_RUNTIME_TREE_SHA256 = "8765f4296ba83431dfb9fb02ae7dc5bc4d8b5a41beb4d247e9752292d330e8e0";

const MAX_RUNTIME_FILES = 500;
const MAX_RUNTIME_FILE_BYTES = 4 * 1024 * 1024;

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSafeRuntimePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 220 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("YAML runtime contains an unsafe path.");
  }
}

export function runtimeTreeDigest(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_RUNTIME_FILES) {
    throw new Error("YAML runtime file inventory is invalid.");
  }
  const sorted = [...entries].sort((left, right) => comparePaths(left.path, right.path));
  const seen = new Set();
  const tree = createHash("sha256");
  for (const entry of sorted) {
    assertSafeRuntimePath(entry.path);
    if (seen.has(entry.path) || !Buffer.isBuffer(entry.bytes)) {
      throw new Error("YAML runtime file inventory is invalid.");
    }
    if (entry.bytes.length === 0 || entry.bytes.length > MAX_RUNTIME_FILE_BYTES) {
      throw new Error("YAML runtime contains an empty or oversized file: " + entry.path);
    }
    seen.add(entry.path);
    const fileDigest = createHash("sha256").update(entry.bytes).digest("hex");
    tree.update(entry.path, "utf8");
    tree.update("\0", "utf8");
    tree.update(String(entry.bytes.length), "ascii");
    tree.update("\0", "utf8");
    tree.update(fileDigest, "ascii");
    tree.update("\n", "utf8");
  }
  return tree.digest("hex");
}

async function collectRuntimeEntries(directory, prefix = "") {
  const before = await lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("YAML runtime contains an unsafe directory: " + (prefix || "."));
  }
  const files = [];
  const directoryEntries = await readdir(directory, { withFileTypes: true });
  directoryEntries.sort((left, right) => comparePaths(left.name, right.name));
  for (const entry of directoryEntries) {
    const relativePath = path.posix.join(prefix, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("YAML runtime contains a symlink: " + relativePath);
    if (entry.isDirectory()) {
      files.push(...(await collectRuntimeEntries(absolutePath, relativePath)));
      continue;
    }
    if (!entry.isFile()) throw new Error("YAML runtime contains an unsupported entry: " + relativePath);
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_RUNTIME_FILE_BYTES) {
      throw new Error("YAML runtime contains an empty or oversized file: " + relativePath);
    }
    let handle;
    try {
      handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFileIdentity(metadata, opened) || opened.size !== metadata.size) {
        throw new Error("YAML runtime file changed while being opened: " + relativePath);
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (bytes.length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
        throw new Error("YAML runtime file changed while being read: " + relativePath);
      }
      files.push({ path: relativePath, bytes });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  const after = await lstat(directory);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !sameFileIdentity(before, after) ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error("YAML runtime directory changed while being inspected: " + (prefix || "."));
  }
  return files;
}

export async function calculateYamlRuntimeTreeSha256(directory) {
  return runtimeTreeDigest(await collectRuntimeEntries(directory));
}

export async function verifyYamlRuntimeDirectory(directory) {
  const digest = await calculateYamlRuntimeTreeSha256(directory);
  if (digest !== YAML_RUNTIME_TREE_SHA256) {
    throw new Error("The installed YAML runtime file tree does not match the pinned integrity contract.");
  }
  return digest;
}
