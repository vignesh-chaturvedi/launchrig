import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  runtimeTreeDigest,
  YAML_RUNTIME_LICENSE,
  YAML_RUNTIME_NAME,
  YAML_RUNTIME_TREE_SHA256,
  YAML_RUNTIME_VERSION,
} from "./runtime-contract.mjs";

const BUNDLE_KIND = "launchrig-publisher-bundle";
const CLAIM_KEYS = [
  "confirmedDefect",
  "externalPublisher",
  "productionWallet",
  "seedVault",
  "seekerHardware",
];
const REHEARSAL_CHECKS = [
  "offline-package-install",
  "installed-version-match",
  "installed-help-contract",
  "pilot-timer-start",
  "starter-generation",
  "starter-validation",
  "device-free-preflight-refusal",
];
const SOURCE_VERIFICATION_CHECKS = [
  "package-manager-version",
  "frozen-offline-dependency-restore",
  "typecheck",
  "test-suite",
  "package-smoke",
];
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PAYLOAD_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 1000;
const BUNDLE_PROFILE_V1 = "phase-2a-publisher-rc-v1";
const BUNDLE_PROFILE_V2 = "phase-2b-publisher-rc-v2";
const BUNDLE_PROFILE_V3 = "phase-2c-publisher-rc-v3";
const BUNDLE_PROFILE_V4 = "phase-3-foundation-rc-v4";
const BUNDLE_PROFILE_V5 = "phase-3-config-parity-rc-v5";
const PACKED_DOCUMENTS_V1 = [
  "docs/flows/mwa-authorize.md",
  "docs/flows/mwa-reject.md",
  "docs/flows/mwa-sign-message.md",
  "docs/flows/mwa-siws.md",
  "docs/phase-1.md",
  "docs/phase-2.md",
  "docs/physical-device.md",
  "docs/publisher-bundle-readme.md",
  "docs/publisher-pilot-quickstart.md",
  "docs/supported-environment.md",
];
const PACKED_DOCUMENTS_V2 = [
  "docs/cohort-verification.md",
  "docs/flows/mwa-authorize.md",
  "docs/flows/mwa-reject.md",
  "docs/flows/mwa-sign-message.md",
  "docs/flows/mwa-siws.md",
  "docs/phase-1.md",
  "docs/phase-2.md",
  "docs/physical-device.md",
  "docs/publisher-bundle-readme.md",
  "docs/publisher-pilot-quickstart.md",
  "docs/supported-environment.md",
];
const PACKED_DOCUMENTS_V3 = [
  "docs/cohort-audit.md",
  "docs/cohort-verification.md",
  "docs/flows/mwa-authorize.md",
  "docs/flows/mwa-reject.md",
  "docs/flows/mwa-sign-message.md",
  "docs/flows/mwa-siws.md",
  "docs/phase-1.md",
  "docs/phase-2.md",
  "docs/physical-device.md",
  "docs/publisher-bundle-readme.md",
  "docs/publisher-pilot-quickstart.md",
  "docs/supported-environment.md",
];
const PACKED_DOCUMENTS_V4 = [
  "docs/cohort-audit.md",
  "docs/cohort-verification.md",
  "docs/flows/mwa-authorize.md",
  "docs/flows/mwa-reject.md",
  "docs/flows/mwa-sign-message.md",
  "docs/flows/mwa-siws.md",
  "docs/phase-1.md",
  "docs/phase-2.md",
  "docs/phase-3-foundation.md",
  "docs/physical-device.md",
  "docs/publisher-bundle-readme.md",
  "docs/publisher-pilot-quickstart.md",
  "docs/supported-environment.md",
];
const PACKED_DOCUMENTS_V5 = [
  "docs/cohort-audit.md",
  "docs/cohort-verification.md",
  "docs/config-v1-compatibility.md",
  "docs/flows/mwa-authorize.md",
  "docs/flows/mwa-reject.md",
  "docs/flows/mwa-sign-message.md",
  "docs/flows/mwa-siws.md",
  "docs/phase-1.md",
  "docs/phase-2.md",
  "docs/phase-3-foundation.md",
  "docs/physical-device.md",
  "docs/publisher-bundle-readme.md",
  "docs/publisher-pilot-quickstart.md",
  "docs/supported-environment.md",
];
const PACKED_SCHEMAS_V1 = [
  "schemas/launchrig-pilot-evidence-v1.schema.json",
  "schemas/launchrig-pilot-evidence-v2.schema.json",
  "schemas/launchrig-pilot-evidence.schema.json",
  "schemas/launchrig-publisher-bundle.schema.json",
  "schemas/launchrig.schema.json",
];
const PACKED_SCHEMAS_V2 = [
  "schemas/launchrig-cohort-verification.schema.json",
  "schemas/launchrig-pilot-evidence-v1.schema.json",
  "schemas/launchrig-pilot-evidence-v2.schema.json",
  "schemas/launchrig-pilot-evidence.schema.json",
  "schemas/launchrig-publisher-bundle.schema.json",
  "schemas/launchrig.schema.json",
];
const PACKED_SCHEMAS_V3 = [
  "schemas/launchrig-cohort-verification.schema.json",
  "schemas/launchrig-pilot-evidence-v1.schema.json",
  "schemas/launchrig-pilot-evidence-v2.schema.json",
  "schemas/launchrig-pilot-evidence.schema.json",
  "schemas/launchrig-private-cohort-audit.schema.json",
  "schemas/launchrig-private-cohort-register.schema.json",
  "schemas/launchrig-publisher-bundle.schema.json",
  "schemas/launchrig.schema.json",
];
const PACKED_SCHEMAS_V4 = [
  "schemas/launchrig-cohort-verification.schema.json",
  "schemas/launchrig-core-rule-catalog.schema.json",
  "schemas/launchrig-pilot-evidence-v1.schema.json",
  "schemas/launchrig-pilot-evidence-v2.schema.json",
  "schemas/launchrig-pilot-evidence.schema.json",
  "schemas/launchrig-private-cohort-audit.schema.json",
  "schemas/launchrig-private-cohort-register.schema.json",
  "schemas/launchrig-publisher-bundle.schema.json",
  "schemas/launchrig.schema.json",
];
const PACKED_SCHEMAS_V5 = [
  "schemas/fixtures/launchrig-config-v1.conformance.json",
  "schemas/launchrig-cohort-verification.schema.json",
  "schemas/launchrig-core-rule-catalog.schema.json",
  "schemas/launchrig-pilot-evidence-v1.schema.json",
  "schemas/launchrig-pilot-evidence-v2.schema.json",
  "schemas/launchrig-pilot-evidence.schema.json",
  "schemas/launchrig-private-cohort-audit.schema.json",
  "schemas/launchrig-private-cohort-register.schema.json",
  "schemas/launchrig-publisher-bundle.schema.json",
  "schemas/launchrig.schema.json",
];
const PACKED_TEMPLATES = [
  "templates/defect-evidence.md",
  "templates/pilot-consent.md",
  "templates/pilot-notes.md",
  "templates/publisher-intake.md",
  "templates/sharing-review.md",
];

function packedInventory(profile) {
  if (profile === BUNDLE_PROFILE_V1) {
    return { documents: PACKED_DOCUMENTS_V1, schemas: PACKED_SCHEMAS_V1 };
  }
  if (profile === BUNDLE_PROFILE_V2) {
    return { documents: PACKED_DOCUMENTS_V2, schemas: PACKED_SCHEMAS_V2 };
  }
  if (profile === BUNDLE_PROFILE_V3) {
    return { documents: PACKED_DOCUMENTS_V3, schemas: PACKED_SCHEMAS_V3 };
  }
  if (profile === BUNDLE_PROFILE_V4) {
    return { documents: PACKED_DOCUMENTS_V4, schemas: PACKED_SCHEMAS_V4 };
  }
  if (profile === BUNDLE_PROFILE_V5) {
    return { documents: PACKED_DOCUMENTS_V5, schemas: PACKED_SCHEMAS_V5 };
  }
  throw new Error("Unsupported bundle manifest.");
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object.");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(label + " has unknown or missing fields.");
}

function assertSafeRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 200 ||
    value.includes("\\") ||
    value.includes("\0") ||
    /[\r\n]/.test(value) ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Manifest contains an unsafe payload path.");
  }
}

async function collectFiles(directory, prefix = "") {
  const files = [];
  const before = await lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("Bundle contains an unsafe directory: " + (prefix || "."));
  }
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => comparePaths(left.name, right.name));
  for (const entry of entries) {
    const relativePath = path.posix.join(prefix, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Bundle contains a symlink: " + relativePath);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath, relativePath)));
      continue;
    }
    if (!entry.isFile()) throw new Error("Bundle contains an unsupported entry: " + relativePath);
    files.push(relativePath);
  }
  const after = await lstat(directory);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !sameFileIdentity(before, after) ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error("Bundle directory changed while being inspected: " + (prefix || "."));
  }
  return files.sort();
}

async function readRegularFile(bundleRoot, relativePath, maximumBytes) {
  assertSafeRelativePath(relativePath);
  const candidate = path.join(bundleRoot, ...relativePath.split("/"));
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maximumBytes) {
    throw new Error("Bundle file is unsafe or oversized: " + relativePath);
  }
  const resolved = await realpath(candidate);
  if (!resolved.startsWith(bundleRoot + path.sep)) throw new Error("Bundle file escapes its root: " + relativePath);
  let handle;
  try {
    handle = await open(
      resolved,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
    );
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(metadata, opened) || opened.size !== metadata.size) {
      throw new Error("Bundle file changed while being opened: " + relativePath);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error("Bundle file changed while being read: " + relativePath);
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function expectedPayloadFiles(version) {
  return [
    "README.md",
    "docs/publisher-pilot-quickstart.md",
    "docs/supported-environment.md",
    "docs/flows/mwa-authorize.md",
    "docs/flows/mwa-reject.md",
    "docs/flows/mwa-sign-message.md",
    "docs/flows/mwa-siws.md",
    "launchrig-" + version + ".tgz",
    "schemas/launchrig-publisher-bundle.schema.json",
    "templates/defect-evidence.md",
    "templates/pilot-consent.md",
    "templates/pilot-notes.md",
    "templates/publisher-intake.md",
    "templates/sharing-review.md",
  ].sort();
}

function decodeTarField(header, start, length, label) {
  const field = header.subarray(start, start + length);
  const zeroIndex = field.indexOf(0);
  const bytes = zeroIndex >= 0 ? field.subarray(0, zeroIndex) : field;
  if ([...bytes].some((byte) => byte < 0x20 || byte > 0x7e)) {
    throw new Error("LaunchRig package archive has a non-ASCII " + label + ".");
  }
  return Buffer.from(bytes).toString("ascii").trimEnd();
}

function decodeTarOctal(header, start, length, label) {
  const raw = header.subarray(start, start + length);
  if ((raw[0] ?? 0) & 0x80) throw new Error("LaunchRig package archive uses unsupported numeric encoding.");
  const value = Buffer.from(raw).toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("LaunchRig package archive has an invalid " + label + ".");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("LaunchRig package archive has an unsafe " + label + ".");
  }
  return parsed;
}

function assertTarChecksum(header) {
  const expected = decodeTarOctal(header, 148, 8, "header checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (actual !== expected) throw new Error("LaunchRig package archive has an invalid header checksum.");
}

function assertSafeArchivePath(value) {
  if (
    value.length === 0 ||
    value.length > 220 ||
    !value.startsWith("package/") ||
    value.includes("\\") ||
    /[\r\n\0]/.test(value) ||
    !/^[A-Za-z0-9._+@/-]+$/.test(value) ||
    path.posix.normalize(value) !== value ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("LaunchRig package archive contains an unsafe path.");
  }
}

function isAllowedArchivePath(archivePath, inventory) {
  const relativePath = archivePath.slice("package/".length);
  const baseName = path.posix.basename(relativePath);
  const parts = relativePath.split("/");
  const rootDirectory = parts.length > 1 ? parts[0] : "";
  if (
    [".git", ".launchrig", ".superstack", "apps", "fixtures", "scripts", "test"].includes(rootDirectory) ||
    parts.some((part) => [".git", ".launchrig", ".superstack"].includes(part)) ||
    baseName.startsWith(".env") ||
    /\.(?:apk|jks|keystore|key|log|p12|pem)$/i.test(baseName)
  ) {
    return false;
  }
  return (
    relativePath === "LICENSE" ||
    relativePath === "README.md" ||
    relativePath === "package.json" ||
    (relativePath.startsWith("dist/src/") && /\.(?:js|js\.map|d\.ts)$/.test(relativePath)) ||
    relativePath.startsWith("dist/node_modules/yaml/") ||
    inventory.documents.includes(relativePath) ||
    inventory.schemas.includes(relativePath) ||
    PACKED_TEMPLATES.includes(relativePath)
  );
}

export function inspectLaunchRigArchive(archiveBytes, manifest) {
  const inventory = packedInventory(manifest.profile);
  let archive;
  try {
    archive = gunzipSync(archiveBytes, { maxOutputLength: MAX_ARCHIVE_EXPANDED_BYTES });
  } catch {
    throw new Error("LaunchRig package archive is not a bounded gzip stream.");
  }
  if (archive.length === 0 || archive.length % 512 !== 0) {
    throw new Error("LaunchRig package archive has an invalid tar length.");
  }

  const entries = new Map();
  const caseFoldedPaths = new Set();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!archive.subarray(offset).every((byte) => byte === 0)) {
        throw new Error("LaunchRig package archive has data after its end marker.");
      }
      ended = true;
      break;
    }
    if (entries.size >= MAX_ARCHIVE_FILES) throw new Error("LaunchRig package archive has too many files.");
    assertTarChecksum(header);
    const name = decodeTarField(header, 0, 100, "path");
    const prefix = decodeTarField(header, 345, 155, "path prefix");
    const archivePath = prefix ? prefix + "/" + name : name;
    assertSafeArchivePath(archivePath);
    const type = header[156] ?? 0;
    if (type !== 0 && type !== 0x30) {
      throw new Error("LaunchRig package archive contains a nonregular entry: " + archivePath);
    }
    if (!isAllowedArchivePath(archivePath, inventory)) {
      throw new Error("LaunchRig package archive contains a file outside the release allowlist: " + archivePath);
    }
    const foldedPath = archivePath.toLowerCase();
    if (entries.has(archivePath) || caseFoldedPaths.has(foldedPath)) {
      throw new Error("LaunchRig package archive contains a duplicate path.");
    }
    const size = decodeTarOctal(header, 124, 12, "file size");
    if (size <= 0 || size > MAX_ARCHIVE_FILE_BYTES) {
      throw new Error("LaunchRig package archive contains an empty or oversized file: " + archivePath);
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const nextOffset = dataStart + Math.ceil(size / 512) * 512;
    if (dataEnd > archive.length || nextOffset > archive.length) {
      throw new Error("LaunchRig package archive contains a truncated file.");
    }
    entries.set(archivePath, archive.subarray(dataStart, dataEnd));
    caseFoldedPaths.add(foldedPath);
    offset = nextOffset;
  }
  if (!ended) throw new Error("LaunchRig package archive has no end marker.");

  for (const [label, expected, prefix] of [
    ["documentation", inventory.documents, "package/docs/"],
    ["schema", inventory.schemas, "package/schemas/"],
    ["template", PACKED_TEMPLATES, "package/templates/"],
  ]) {
    const actual = [...entries.keys()]
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice("package/".length))
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
      throw new Error("LaunchRig package " + label + " inventory does not match the release allowlist.");
    }
  }

  for (const required of [
    "package/LICENSE",
    "package/README.md",
    "package/dist/src/cli.js",
    "package/dist/node_modules/yaml/LICENSE",
    "package/dist/node_modules/yaml/package.json",
    "package/package.json",
  ]) {
    if (!entries.has(required)) throw new Error("LaunchRig package archive is missing " + required + ".");
  }

  const yamlPrefix = "package/dist/node_modules/yaml/";
  const yamlEntries = [...entries.entries()]
    .filter(([entryPath]) => entryPath.startsWith(yamlPrefix))
    .map(([entryPath, bytes]) => ({ path: entryPath.slice(yamlPrefix.length), bytes }));
  if (runtimeTreeDigest(yamlEntries) !== YAML_RUNTIME_TREE_SHA256) {
    throw new Error("Vendored YAML file tree does not match the pinned integrity contract.");
  }

  let packageMetadata;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(entries.get("package/package.json"));
    packageMetadata = JSON.parse(source);
  } catch {
    throw new Error("LaunchRig package metadata is not valid UTF-8 JSON.");
  }
  if (
    packageMetadata.name !== "launchrig" ||
    packageMetadata.version !== manifest.launchRigVersion ||
    packageMetadata.private !== true ||
    packageMetadata.bin?.launchrig !== "dist/src/cli.js" ||
    packageMetadata.engines?.node !== manifest.package.nodeEngine ||
    packageMetadata.dependencies !== undefined ||
    ["preinstall", "install", "postinstall", "prepare"].some(
      (script) => packageMetadata.scripts?.[script] !== undefined,
    )
  ) {
    throw new Error("LaunchRig package metadata does not match the safe bundle contract.");
  }
  let yamlMetadata;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(
      entries.get("package/dist/node_modules/yaml/package.json"),
    );
    yamlMetadata = JSON.parse(source);
  } catch {
    throw new Error("Vendored YAML package metadata is not valid UTF-8 JSON.");
  }
  if (
    yamlMetadata.name !== YAML_RUNTIME_NAME ||
    yamlMetadata.version !== YAML_RUNTIME_VERSION ||
    yamlMetadata.license !== YAML_RUNTIME_LICENSE
  ) {
    throw new Error("Vendored YAML package metadata does not match the pinned runtime contract.");
  }
}

function validateManifest(manifest) {
  assertExactKeys(
    manifest,
    [
      "schemaVersion",
      "kind",
      "profile",
      "bundleId",
      "launchRigVersion",
      "source",
      "package",
      "consumerRehearsal",
      "sourceVerification",
      "claims",
      "scope",
      "grantReady",
      "files",
      "payloadSha256",
    ],
    "Bundle manifest",
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== BUNDLE_KIND ||
    ![
      BUNDLE_PROFILE_V1,
      BUNDLE_PROFILE_V2,
      BUNDLE_PROFILE_V3,
      BUNDLE_PROFILE_V4,
      BUNDLE_PROFILE_V5,
    ].includes(manifest.profile)
  ) {
    throw new Error("Unsupported bundle manifest.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.launchRigVersion)) throw new Error("Invalid LaunchRig version in manifest.");
  if (manifest.grantReady !== false) throw new Error("Bundle manifest must not claim grant readiness.");

  assertExactKeys(manifest.source, ["gitCommit", "lockfileSha256", "worktree"], "Manifest source");
  if (
    !/^[a-f0-9]{40}$/.test(manifest.source.gitCommit) ||
    !/^[a-f0-9]{64}$/.test(manifest.source.lockfileSha256) ||
    manifest.source.worktree !== "clean"
  ) {
    throw new Error("Bundle source must identify a clean full Git commit.");
  }

  assertExactKeys(
    manifest.package,
    ["name", "path", "sizeBytes", "sha256", "private", "nodeEngine", "packageManager"],
    "Manifest package",
  );
  if (
    manifest.package.name !== "launchrig" ||
    manifest.package.private !== true ||
    typeof manifest.package.nodeEngine !== "string" ||
    manifest.package.nodeEngine.length === 0 ||
    manifest.package.nodeEngine.length > 40 ||
    !/^pnpm@\d+\.\d+\.\d+$/.test(manifest.package.packageManager)
  ) {
    throw new Error("Bundle package contract is invalid.");
  }
  assertExactKeys(
    manifest.consumerRehearsal,
    ["status", "mode", "checks", "deviceOrWalletTested"],
    "Consumer rehearsal",
  );
  if (
    manifest.consumerRehearsal.status !== "passed" ||
    manifest.consumerRehearsal.mode !== "clean-offline-pnpm-install" ||
    manifest.consumerRehearsal.deviceOrWalletTested !== false ||
    JSON.stringify(manifest.consumerRehearsal.checks) !== JSON.stringify(REHEARSAL_CHECKS)
  ) {
    throw new Error("Bundle consumer rehearsal contract is invalid.");
  }
  assertExactKeys(manifest.sourceVerification, ["status", "checks"], "Source verification");
  if (
    manifest.sourceVerification.status !== "passed" ||
    JSON.stringify(manifest.sourceVerification.checks) !== JSON.stringify(SOURCE_VERIFICATION_CHECKS)
  ) {
    throw new Error("Bundle source verification contract is invalid.");
  }

  assertExactKeys(manifest.claims, CLAIM_KEYS, "Manifest claims");
  for (const key of CLAIM_KEYS) {
    if (manifest.claims[key] !== "not-established") throw new Error("Bundle external claims must remain not established.");
  }
  assertExactKeys(
    manifest.scope,
    ["includesApks", "includesPrivatePilotState", "includesPublisherEvidence"],
    "Manifest scope",
  );
  if (
    manifest.scope.includesApks !== false ||
    manifest.scope.includesPrivatePilotState !== false ||
    manifest.scope.includesPublisherEvidence !== false
  ) {
    throw new Error("Bundle must exclude APKs, private pilot state, and publisher evidence.");
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > 50) {
    throw new Error("Manifest file inventory is invalid.");
  }
  const paths = [];
  for (const file of manifest.files) {
    assertExactKeys(file, ["path", "sizeBytes", "sha256"], "Manifest file");
    assertSafeRelativePath(file.path);
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > MAX_PAYLOAD_BYTES) {
      throw new Error("Manifest file size is invalid: " + file.path);
    }
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Manifest file digest is invalid: " + file.path);
    paths.push(file.path);
  }
  const sortedPaths = [...paths].sort();
  if (JSON.stringify(paths) !== JSON.stringify(sortedPaths) || new Set(paths).size !== paths.length) {
    throw new Error("Manifest file inventory must be unique and sorted.");
  }
  const expectedPaths = expectedPayloadFiles(manifest.launchRigVersion);
  if (JSON.stringify(paths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Bundle payload does not match the exact publisher profile allowlist.");
  }

  const payloadSha256 = sha256(canonicalJson(manifest.files));
  if (manifest.payloadSha256 !== payloadSha256) {
    throw new Error("Bundle payload identity does not match its file inventory.");
  }
  const { bundleId, ...manifestCore } = manifest;
  if (bundleId !== "sha256:" + sha256(canonicalJson(manifestCore))) {
    throw new Error("Bundle identity does not match its manifest provenance and payload.");
  }
  const packageFile = manifest.files.find((file) => file.path === manifest.package.path);
  if (
    manifest.package.path !== "launchrig-" + manifest.launchRigVersion + ".tgz" ||
    !packageFile ||
    manifest.package.sizeBytes !== packageFile.sizeBytes ||
    manifest.package.sha256 !== packageFile.sha256
  ) {
    throw new Error("Bundle package identity does not match its payload entry.");
  }
}

export async function verifyPublisherBundle(directory) {
  const requestedRoot = path.resolve(directory);
  const rootMetadata = await lstat(requestedRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Bundle root must be a non-symlink directory.");
  }
  const bundleRoot = await realpath(requestedRoot);
  const resolvedRootMetadata = await lstat(bundleRoot);
  if (
    resolvedRootMetadata.isSymbolicLink() ||
    !resolvedRootMetadata.isDirectory() ||
    !sameFileIdentity(rootMetadata, resolvedRootMetadata)
  ) {
    throw new Error("Bundle root changed while being resolved.");
  }
  const manifestBytes = await readRegularFile(bundleRoot, "manifest.json", MAX_MANIFEST_BYTES);
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    throw new Error("Bundle manifest is not valid UTF-8 JSON.");
  }
  const normalizedManifest = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  if (!manifestBytes.equals(normalizedManifest)) throw new Error("Bundle manifest must use canonical formatting.");
  validateManifest(manifest);

  const actualFiles = await collectFiles(bundleRoot);
  const expectedFiles = [...manifest.files.map((file) => file.path), "manifest.json", "SHA256SUMS"].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("Bundle contains missing or unlisted files.");
  }

  let packageArchiveBytes;
  for (const file of manifest.files) {
    const bytes = await readRegularFile(bundleRoot, file.path, MAX_PAYLOAD_BYTES);
    if (bytes.length !== file.sizeBytes || sha256(bytes) !== file.sha256) {
      throw new Error("Bundle payload checksum mismatch: " + file.path);
    }
    if (file.path === manifest.package.path) packageArchiveBytes = bytes;
  }
  if (!packageArchiveBytes) throw new Error("Bundle package archive is missing.");
  inspectLaunchRigArchive(packageArchiveBytes, manifest);
  const expectedSums =
    manifest.files.map((file) => file.sha256 + "  " + file.path).join("\n") + "\n";
  const sums = await readRegularFile(bundleRoot, "SHA256SUMS", MAX_MANIFEST_BYTES);
  if (!sums.equals(Buffer.from(expectedSums, "utf8"))) throw new Error("SHA256SUMS does not match the manifest.");
  const finalRootMetadata = await lstat(requestedRoot);
  const finalResolvedRootMetadata = await lstat(bundleRoot);
  if (
    finalRootMetadata.isSymbolicLink() ||
    !finalRootMetadata.isDirectory() ||
    !sameFileIdentity(rootMetadata, finalRootMetadata) ||
    finalResolvedRootMetadata.isSymbolicLink() ||
    !finalResolvedRootMetadata.isDirectory() ||
    !sameFileIdentity(resolvedRootMetadata, finalResolvedRootMetadata) ||
    rootMetadata.mtimeMs !== finalRootMetadata.mtimeMs ||
    resolvedRootMetadata.mtimeMs !== finalResolvedRootMetadata.mtimeMs
  ) {
    throw new Error("Bundle root changed while being verified.");
  }
  return manifest;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  const defaultRoot = path.dirname(modulePath);
  const target = process.argv[2] ? path.resolve(process.argv[2]) : defaultRoot;
  try {
    const manifest = await verifyPublisherBundle(target);
    console.log("LaunchRig publisher bundle verified.");
    console.log("bundle id: " + manifest.bundleId);
    console.log("package sha256: " + manifest.package.sha256);
    console.log("grant ready: no");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
