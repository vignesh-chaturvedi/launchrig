import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const BUNDLE_SCHEMA_VERSION = 1;
export const BUNDLE_KIND = "launchrig-publisher-bundle";
export const BUNDLE_PROFILE = "phase-2c-publisher-rc-v3";
const SUPPORTED_BUNDLE_PROFILES = new Set([
  "phase-2a-publisher-rc-v1",
  "phase-2b-publisher-rc-v2",
  "phase-2c-publisher-rc-v3",
]);
export const REHEARSAL_CHECKS = Object.freeze([
  "offline-package-install",
  "installed-version-match",
  "installed-help-contract",
  "pilot-timer-start",
  "starter-generation",
  "starter-validation",
  "device-free-preflight-refusal",
]);
export const SOURCE_VERIFICATION_CHECKS = Object.freeze([
  "package-manager-version",
  "frozen-offline-dependency-restore",
  "typecheck",
  "test-suite",
  "package-smoke",
]);
export const UNESTABLISHED_CLAIMS = Object.freeze({
  externalPublisher: "not-established",
  seekerHardware: "not-established",
  productionWallet: "not-established",
  seedVault: "not-established",
  confirmedDefect: "not-established",
});

const MAX_PAYLOAD_BYTES = 100 * 1024 * 1024;
const MAX_COPY_BYTES = MAX_PAYLOAD_BYTES;
const RESERVED_FILES = new Set(["manifest.json", "SHA256SUMS"]);

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map((entry) => canonicalJson(entry)).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
      .join(",") +
    "}"
  );
}

export function sha256Value(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseBundleArguments(args) {
  let output;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--output") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output requires an absolute directory path.");
      output = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--output=")) {
      output = argument.slice("--output=".length);
      continue;
    }
    throw new Error("Unknown pilot bundle argument: " + argument);
  }
  if (!help && !output) throw new Error("--output is required.");
  return { help, output };
}

export async function resolveNewOutputDirectory(output) {
  if (typeof output !== "string" || !path.isAbsolute(output)) {
    throw new Error("The pilot bundle output must be an absolute path.");
  }
  const normalized = path.normalize(output);
  const parsed = path.parse(normalized);
  if (normalized === parsed.root || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parsed.base)) {
    throw new Error("The pilot bundle output must end with a safe directory name.");
  }
  try {
    await lstat(normalized);
    throw new Error("The pilot bundle output already exists: " + normalized);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The pilot bundle output already exists:")) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = parsed.dir;
  const parentMetadata = await lstat(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error("The pilot bundle output parent must be an existing, non-symlink directory.");
  }
  const resolvedParent = await realpath(parent);
  return {
    parentDirectory: resolvedParent,
    outputDirectory: path.join(resolvedParent, parsed.base),
  };
}

async function readRegularFile(filePath, maximumBytes) {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maximumBytes) {
    throw new Error("Refusing unsafe or oversized bundle input: " + filePath);
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile() || openedMetadata.size !== metadata.size) {
      throw new Error("Bundle input changed while being opened: " + filePath);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== openedMetadata.size) throw new Error("Bundle input changed while being read: " + filePath);
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function copyRegularBundleInput(source, destination) {
  const bytes = await readRegularFile(source, MAX_COPY_BYTES);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await writeFile(destination, bytes, { flag: "wx", mode: 0o644 });
}

async function collectRelativeFiles(directory, prefix = "") {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => comparePaths(left.name, right.name));
  for (const entry of entries) {
    const relativePath = path.posix.join(prefix, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Bundle payload must not contain symlinks: " + relativePath);
    if (entry.isDirectory()) {
      files.push(...(await collectRelativeFiles(absolutePath, relativePath)));
      continue;
    }
    if (!entry.isFile()) throw new Error("Bundle payload contains an unsupported entry: " + relativePath);
    if (!RESERVED_FILES.has(relativePath)) files.push(relativePath);
  }
  return files;
}

export async function collectPayloadEntries(directory) {
  const paths = await collectRelativeFiles(directory);
  const files = [];
  for (const relativePath of paths.sort()) {
    const bytes = await readRegularFile(path.join(directory, ...relativePath.split("/")), MAX_PAYLOAD_BYTES);
    if (bytes.length === 0) throw new Error("Bundle payload files must not be empty: " + relativePath);
    files.push({
      path: relativePath,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return files;
}

export function createPublisherManifest({
  profile = BUNDLE_PROFILE,
  launchRigVersion,
  gitCommit,
  lockfileSha256,
  nodeEngine,
  packageManager,
  packagePath,
  files,
}) {
  if (!SUPPORTED_BUNDLE_PROFILES.has(profile)) throw new Error("Publisher bundle profile is unsupported.");
  if (!/^\d+\.\d+\.\d+$/.test(launchRigVersion)) throw new Error("LaunchRig version must be plain semver.");
  if (!/^[a-f0-9]{40}$/.test(gitCommit)) throw new Error("Source commit must be a full lowercase Git commit.");
  if (!/^[a-f0-9]{64}$/.test(lockfileSha256)) throw new Error("Lockfile digest must be lowercase SHA-256.");
  if (typeof nodeEngine !== "string" || nodeEngine.length === 0 || nodeEngine.length > 40) {
    throw new Error("Node engine requirement is invalid.");
  }
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)) throw new Error("Package manager requirement is invalid.");
  const sortedFiles = [...files].sort((left, right) => comparePaths(left.path, right.path));
  const packageFile = sortedFiles.find((entry) => entry.path === packagePath);
  if (!packageFile) throw new Error("Packed LaunchRig archive is missing from the bundle payload.");
  const payloadSha256 = sha256Value(sortedFiles);
  const manifestCore = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    kind: BUNDLE_KIND,
    profile,
    launchRigVersion,
    source: {
      gitCommit,
      lockfileSha256,
      worktree: "clean",
    },
    package: {
      name: "launchrig",
      path: packageFile.path,
      sizeBytes: packageFile.sizeBytes,
      sha256: packageFile.sha256,
      private: true,
      nodeEngine,
      packageManager,
    },
    consumerRehearsal: {
      status: "passed",
      mode: "clean-offline-pnpm-install",
      checks: [...REHEARSAL_CHECKS],
      deviceOrWalletTested: false,
    },
    sourceVerification: {
      status: "passed",
      checks: [...SOURCE_VERIFICATION_CHECKS],
    },
    claims: { ...UNESTABLISHED_CLAIMS },
    scope: {
      includesApks: false,
      includesPrivatePilotState: false,
      includesPublisherEvidence: false,
    },
    grantReady: false,
    files: sortedFiles,
    payloadSha256,
  };
  return {
    schemaVersion: manifestCore.schemaVersion,
    kind: manifestCore.kind,
    profile: manifestCore.profile,
    bundleId: "sha256:" + sha256Value(manifestCore),
    launchRigVersion: manifestCore.launchRigVersion,
    source: manifestCore.source,
    package: manifestCore.package,
    consumerRehearsal: manifestCore.consumerRehearsal,
    sourceVerification: manifestCore.sourceVerification,
    claims: manifestCore.claims,
    scope: manifestCore.scope,
    grantReady: manifestCore.grantReady,
    files: manifestCore.files,
    payloadSha256: manifestCore.payloadSha256,
  };
}

export function renderSha256Sums(files) {
  return [...files]
    .sort((left, right) => comparePaths(left.path, right.path))
    .map((entry) => entry.sha256 + "  " + entry.path)
    .join("\n") + "\n";
}
