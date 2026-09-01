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
const LEGACY_REHEARSAL_CHECKS = [
  "offline-package-install",
  "installed-version-match",
  "installed-help-contract",
  "pilot-timer-start",
  "starter-generation",
  "starter-validation",
  "device-free-preflight-refusal",
];
const REHEARSAL_CHECKS_V7 = [
  ...LEGACY_REHEARSAL_CHECKS,
  "device-free-pilot-policy-lint-refusal",
];
const REHEARSAL_CHECKS_V8 = [
  ...REHEARSAL_CHECKS_V7,
  "device-free-session-scope-receipt",
];
const REHEARSAL_CHECKS_V9 = [
  ...REHEARSAL_CHECKS_V8,
  "device-free-approved-scope-enforcement",
];
const REHEARSAL_CHECKS_V10 = [
  ...REHEARSAL_CHECKS_V9,
  "installed-scope-linked-governance-contract",
];
const REHEARSAL_CHECKS_V11 = [
  ...REHEARSAL_CHECKS_V10,
  "device-free-consent-safe-scope-preparation",
];
const REHEARSAL_CHECKS_V12 = [
  ...REHEARSAL_CHECKS_V11,
  "device-free-private-recruitment-register-preparation",
];
const REHEARSAL_CHECKS_V13 = [
  ...REHEARSAL_CHECKS_V12,
  "device-free-private-prospect-review-confirmation-refusal",
];
const REHEARSAL_CHECKS_V14 = [
  ...REHEARSAL_CHECKS_V13,
  "device-free-private-send-decision-preparation-confirmation-refusal",
];
const REHEARSAL_CHECKS_V15 = [
  ...REHEARSAL_CHECKS_V14,
  "device-free-private-human-send-decision-confirmation-refusal",
];
const REHEARSAL_CHECKS_V16 = [
  ...REHEARSAL_CHECKS_V15,
  "device-free-structured-config-diagnostics",
];
const REHEARSAL_CHECKS_V17 = [
  ...REHEARSAL_CHECKS_V16,
  "device-free-runtime-rule-fixtures",
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
const BUNDLE_PROFILE_V6 = "phase-3-validation-action-rc-v6";
const BUNDLE_PROFILE_V7 = "phase-2d-publisher-readiness-rc-v7";
const BUNDLE_PROFILE_V8 = "phase-2e-consent-scope-rc-v8";
const BUNDLE_PROFILE_V9 = "phase-2f-scope-enforced-pilot-rc-v9";
const BUNDLE_PROFILE_V10 = "phase-2g-operational-contract-rc-v10";
const BUNDLE_PROFILE_V11 = "phase-2h-consent-safe-scope-rc-v11";
const BUNDLE_PROFILE_V12 = "phase-2i-recruitment-register-rc-v12";
const BUNDLE_PROFILE_V13 = "phase-2l-human-prospect-review-rc-v13";
const BUNDLE_PROFILE_V14 = "phase-2m-send-decision-preparation-rc-v14";
const BUNDLE_PROFILE_V15 = "phase-2n-human-send-decision-rc-v15";
const BUNDLE_PROFILE_V16 = "phase-3-config-diagnostics-rc-v16";
const BUNDLE_PROFILE_V17 = "phase-3-runtime-rule-fixtures-rc-v17";
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
const PACKED_DOCUMENTS_V6 = [
  "docs/cohort-audit.md",
  "docs/cohort-verification.md",
  "docs/config-v1-compatibility.md",
  "docs/flows/mwa-authorize.md",
  "docs/flows/mwa-reject.md",
  "docs/flows/mwa-sign-message.md",
  "docs/flows/mwa-siws.md",
  "docs/github-action.md",
  "docs/phase-1.md",
  "docs/phase-2.md",
  "docs/phase-3-foundation.md",
  "docs/physical-device.md",
  "docs/publisher-bundle-readme.md",
  "docs/publisher-pilot-quickstart.md",
  "docs/supported-environment.md",
];
const PACKED_DOCUMENTS_V12 = [
  ...PACKED_DOCUMENTS_V6,
  "docs/publisher-recruitment.md",
].sort();
const PACKED_DOCUMENTS_V13 = [
  ...PACKED_DOCUMENTS_V12,
  "docs/publisher-prospect-review.md",
].sort();
const PACKED_DOCUMENTS_V14 = [
  ...PACKED_DOCUMENTS_V13,
  "docs/publisher-send-decision-preparation.md",
].sort();
const PACKED_DOCUMENTS_V15 = [
  ...PACKED_DOCUMENTS_V14,
  "docs/publisher-send-decision-recording.md",
].sort();
const PACKED_DOCUMENTS_V16 = [...PACKED_DOCUMENTS_V15];
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
const PACKED_SCHEMAS_V7 = [
  ...PACKED_SCHEMAS_V5,
  "schemas/launchrig-pilot-evidence-binding-receipt.schema.json",
].sort();
const PACKED_SCHEMAS_V8 = [
  ...PACKED_SCHEMAS_V7,
  "schemas/launchrig-pilot-session-scope-receipt.schema.json",
  "schemas/launchrig-pilot-session-scope.schema.json",
].sort();
const PACKED_SCHEMAS_V9 = [
  ...PACKED_SCHEMAS_V8,
  "schemas/launchrig-pilot-evidence-v3.schema.json",
].sort();
const PACKED_SCHEMAS_V11 = [
  ...PACKED_SCHEMAS_V9,
  "schemas/launchrig-pilot-session-scope-draft-result.schema.json",
].sort();
const PACKED_SCHEMAS_V12 = [
  ...PACKED_SCHEMAS_V11,
  "schemas/launchrig-private-cohort-register-draft-result.schema.json",
].sort();
const PACKED_SCHEMAS_V13 = [
  ...PACKED_SCHEMAS_V12,
  "schemas/launchrig-private-prospect-review-result.schema.json",
  "schemas/launchrig-private-prospect-review.schema.json",
].sort();
const PACKED_SCHEMAS_V14 = [
  ...PACKED_SCHEMAS_V13,
  "schemas/launchrig-private-send-decision-request-result.schema.json",
  "schemas/launchrig-private-send-decision-request.schema.json",
].sort();
const PACKED_SCHEMAS_V15 = [
  ...PACKED_SCHEMAS_V14,
  "schemas/launchrig-private-human-send-decision-result.schema.json",
  "schemas/launchrig-private-human-send-decision.schema.json",
].sort();
const PACKED_SCHEMAS_V16 = [
  ...PACKED_SCHEMAS_V15,
  "schemas/fixtures/launchrig-config-rule-fixtures.v1.json",
  "schemas/launchrig-config-validation-result.schema.json",
].sort();
const PACKED_SCHEMAS_V17 = [
  ...PACKED_SCHEMAS_V16,
  "schemas/fixtures/launchrig-runtime-rule-fixtures.v1.json",
  "schemas/launchrig-runtime-rule-fixtures.schema.json",
].sort();
const PACKED_ACTION_FILES_V6 = [
  "action.yml",
  "action/run-validation.mjs",
  "examples/github-actions/launchrig-validation.yml",
];
const PACKED_COMPILED_ADDITIONS_V7 = [
  "package/dist/src/pilot/binding.d.ts",
  "package/dist/src/pilot/binding.js",
  "package/dist/src/pilot/binding.js.map",
];
const PACKED_COMPILED_ADDITIONS_V8_ONLY = [
  "package/dist/src/pilot/session-scope.d.ts",
  "package/dist/src/pilot/session-scope.js",
  "package/dist/src/pilot/session-scope.js.map",
];
const PACKED_COMPILED_ADDITIONS_V8 = [
  ...PACKED_COMPILED_ADDITIONS_V7,
  ...PACKED_COMPILED_ADDITIONS_V8_ONLY,
];
const PACKED_COMPILED_ADDITIONS_V11_ONLY = [
  "package/dist/src/pilot/scope-preparation.d.ts",
  "package/dist/src/pilot/scope-preparation.js",
  "package/dist/src/pilot/scope-preparation.js.map",
];
const PACKED_COMPILED_ADDITIONS_V12_ONLY = [
  "package/dist/src/pilot/cohort-preparation.d.ts",
  "package/dist/src/pilot/cohort-preparation.js",
  "package/dist/src/pilot/cohort-preparation.js.map",
];
const PACKED_COMPILED_ADDITIONS_V13_ONLY = [
  "package/dist/src/pilot/prospect-review.d.ts",
  "package/dist/src/pilot/prospect-review.js",
  "package/dist/src/pilot/prospect-review.js.map",
];
const PACKED_COMPILED_ADDITIONS_V14_ONLY = [
  "package/dist/src/pilot/send-decision-preparation.d.ts",
  "package/dist/src/pilot/send-decision-preparation.js",
  "package/dist/src/pilot/send-decision-preparation.js.map",
];
const PACKED_COMPILED_ADDITIONS_V15_ONLY = [
  "package/dist/src/pilot/send-decision-recording.d.ts",
  "package/dist/src/pilot/send-decision-recording.js",
  "package/dist/src/pilot/send-decision-recording.js.map",
];
const PACKED_COMPILED_ADDITIONS_V16_ONLY = [
  "package/dist/src/config/diagnostics.d.ts",
  "package/dist/src/config/diagnostics.js",
  "package/dist/src/config/diagnostics.js.map",
];
const PACKED_TEMPLATES_V11 = [
  "templates/defect-evidence.md",
  "templates/pilot-consent.md",
  "templates/pilot-notes.md",
  "templates/publisher-intake.md",
  "templates/sharing-review.md",
];
const PACKED_TEMPLATES_V12 = [
  ...PACKED_TEMPLATES_V11,
  "templates/publisher-fit-check.md",
].sort();
const PACKED_RUNTIME_FILES_V11 = [
  "scripts/runtime-contract.mjs",
  "scripts/verify-pilot-bundle.mjs",
];

function packedInventory(profile) {
  let inventory;
  if (profile === BUNDLE_PROFILE_V1) {
    inventory = { documents: PACKED_DOCUMENTS_V1, schemas: PACKED_SCHEMAS_V1, actionFiles: [] };
  } else if (profile === BUNDLE_PROFILE_V2) {
    inventory = { documents: PACKED_DOCUMENTS_V2, schemas: PACKED_SCHEMAS_V2, actionFiles: [] };
  } else if (profile === BUNDLE_PROFILE_V3) {
    inventory = { documents: PACKED_DOCUMENTS_V3, schemas: PACKED_SCHEMAS_V3, actionFiles: [] };
  } else if (profile === BUNDLE_PROFILE_V4) {
    inventory = { documents: PACKED_DOCUMENTS_V4, schemas: PACKED_SCHEMAS_V4, actionFiles: [] };
  } else if (profile === BUNDLE_PROFILE_V5) {
    inventory = { documents: PACKED_DOCUMENTS_V5, schemas: PACKED_SCHEMAS_V5, actionFiles: [] };
  } else if (profile === BUNDLE_PROFILE_V6) {
    inventory = {
      documents: PACKED_DOCUMENTS_V6,
      schemas: PACKED_SCHEMAS_V5,
      actionFiles: PACKED_ACTION_FILES_V6,
    };
  } else if (profile === BUNDLE_PROFILE_V7) {
    inventory = {
      documents: PACKED_DOCUMENTS_V6,
      schemas: PACKED_SCHEMAS_V7,
      actionFiles: PACKED_ACTION_FILES_V6,
    };
  } else if (profile === BUNDLE_PROFILE_V8) {
    inventory = {
      documents: PACKED_DOCUMENTS_V6,
      schemas: PACKED_SCHEMAS_V8,
      actionFiles: PACKED_ACTION_FILES_V6,
    };
  } else if (profile === BUNDLE_PROFILE_V9) {
    inventory = {
      documents: PACKED_DOCUMENTS_V6,
      schemas: PACKED_SCHEMAS_V9,
      actionFiles: PACKED_ACTION_FILES_V6,
    };
  } else if (profile === BUNDLE_PROFILE_V10) {
    inventory = {
      documents: PACKED_DOCUMENTS_V6,
      schemas: PACKED_SCHEMAS_V9,
      actionFiles: PACKED_ACTION_FILES_V6,
      runtimeFiles: [],
    };
  } else if (profile === BUNDLE_PROFILE_V11) {
    inventory = {
      documents: PACKED_DOCUMENTS_V6,
      schemas: PACKED_SCHEMAS_V11,
      actionFiles: PACKED_ACTION_FILES_V6,
      runtimeFiles: PACKED_RUNTIME_FILES_V11,
    };
  } else if (profile === BUNDLE_PROFILE_V12) {
    inventory = {
      documents: PACKED_DOCUMENTS_V12,
      schemas: PACKED_SCHEMAS_V12,
      actionFiles: PACKED_ACTION_FILES_V6,
      runtimeFiles: PACKED_RUNTIME_FILES_V11,
    };
  } else if (profile === BUNDLE_PROFILE_V13) {
    inventory = {
      documents: PACKED_DOCUMENTS_V13,
      schemas: PACKED_SCHEMAS_V13,
      actionFiles: PACKED_ACTION_FILES_V6,
      runtimeFiles: PACKED_RUNTIME_FILES_V11,
    };
  } else if (profile === BUNDLE_PROFILE_V14) {
    inventory = {
      documents: PACKED_DOCUMENTS_V14,
      schemas: PACKED_SCHEMAS_V14,
      actionFiles: PACKED_ACTION_FILES_V6,
      runtimeFiles: PACKED_RUNTIME_FILES_V11,
    };
  } else if (profile === BUNDLE_PROFILE_V15) {
    inventory = {
      documents: PACKED_DOCUMENTS_V15,
      schemas: PACKED_SCHEMAS_V15,
      actionFiles: PACKED_ACTION_FILES_V6,
      runtimeFiles: PACKED_RUNTIME_FILES_V11,
    };
  } else if (profile === BUNDLE_PROFILE_V16) {
    inventory = {
      documents: PACKED_DOCUMENTS_V16,
      schemas: PACKED_SCHEMAS_V16,
      actionFiles: PACKED_ACTION_FILES_V6,
      runtimeFiles: PACKED_RUNTIME_FILES_V11,
    };
  } else if (profile === BUNDLE_PROFILE_V17) {
    inventory = {
      documents: PACKED_DOCUMENTS_V16,
      schemas: PACKED_SCHEMAS_V17,
      actionFiles: PACKED_ACTION_FILES_V6,
      runtimeFiles: PACKED_RUNTIME_FILES_V11,
    };
  } else {
    throw new Error("Unsupported bundle manifest.");
  }
  return {
    ...inventory,
    templates:
      profile === BUNDLE_PROFILE_V12 ||
      profile === BUNDLE_PROFILE_V13 ||
      profile === BUNDLE_PROFILE_V14 ||
      profile === BUNDLE_PROFILE_V15 ||
      profile === BUNDLE_PROFILE_V16 ||
      profile === BUNDLE_PROFILE_V17
        ? PACKED_TEMPLATES_V12
        : PACKED_TEMPLATES_V11,
  };
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

function metadataFingerprint(metadata, type) {
  return {
    type,
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    size: metadata.size.toString(),
    mode: metadata.mode.toString(),
    nlink: metadata.nlink.toString(),
    mtimeNs: metadata.mtimeNs.toString(),
    ctimeNs: metadata.ctimeNs.toString(),
  };
}

function sameMetadata(left, right, type) {
  return JSON.stringify(metadataFingerprint(left, type)) === JSON.stringify(metadataFingerprint(right, type));
}

function treeRootMatchesMetadata(tree, metadata) {
  const root = tree.entries.find(([relativePath]) => relativePath === ".");
  return Boolean(root) && JSON.stringify(root[1]) === JSON.stringify(metadataFingerprint(metadata, "directory"));
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

async function captureBundleTree(directory, prefix = "", state = { files: [], entries: [] }) {
  const before = await lstat(directory, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("Bundle contains an unsafe directory: " + (prefix || "."));
  }
  state.entries.push([prefix || ".", metadataFingerprint(before, "directory")]);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => comparePaths(left.name, right.name));
  for (const entry of entries) {
    const relativePath = path.posix.join(prefix, entry.name);
    const absolutePath = path.join(directory, entry.name);
    const metadata = await lstat(absolutePath, { bigint: true });
    if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
      throw new Error("Bundle contains a symlink: " + relativePath);
    }
    if (entry.isDirectory() && metadata.isDirectory()) {
      await captureBundleTree(absolutePath, relativePath, state);
      continue;
    }
    if (!entry.isFile() || !metadata.isFile() || metadata.nlink !== 1n) {
      throw new Error("Bundle contains an unsupported entry: " + relativePath);
    }
    state.files.push(relativePath);
    state.entries.push([relativePath, metadataFingerprint(metadata, "file")]);
  }
  const after = await lstat(directory, { bigint: true });
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !sameMetadata(before, after, "directory")
  ) {
    throw new Error("Bundle directory changed while being inspected: " + (prefix || "."));
  }
  if (prefix === "") {
    state.files.sort(comparePaths);
    state.entries.sort((left, right) => comparePaths(left[0], right[0]));
  }
  return state;
}

async function readRegularFile(bundleRoot, relativePath, maximumBytes) {
  assertSafeRelativePath(relativePath);
  const candidate = path.join(bundleRoot, ...relativePath.split("/"));
  const metadata = await lstat(candidate, { bigint: true });
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size < 1n ||
    metadata.size > BigInt(maximumBytes) ||
    metadata.nlink !== 1n
  ) {
    throw new Error("Bundle file is unsafe or oversized: " + relativePath);
  }
  const resolved = await realpath(candidate);
  const relativeResolved = path.relative(bundleRoot, resolved);
  if (
    relativeResolved.length === 0 ||
    path.isAbsolute(relativeResolved) ||
    relativeResolved === ".." ||
    relativeResolved.startsWith(".." + path.sep)
  ) {
    throw new Error("Bundle file escapes its root: " + relativePath);
  }
  let handle;
  try {
    handle = await open(
      resolved,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
    );
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      !sameFileIdentity(metadata, opened) ||
      opened.size !== metadata.size ||
      opened.mtimeNs !== metadata.mtimeNs ||
      opened.ctimeNs !== metadata.ctimeNs ||
      opened.mode !== metadata.mode ||
      opened.nlink !== 1n
    ) {
      throw new Error("Bundle file changed while being opened: " + relativePath);
    }
    const expectedSize = Number(opened.size);
    const buffer = Buffer.alloc(expectedSize + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(candidate, { bigint: true });
    if (
      bytesRead !== expectedSize ||
      !sameFileIdentity(opened, after) ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      after.mode !== opened.mode ||
      after.nlink !== 1n ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !sameFileIdentity(opened, afterPath) ||
      afterPath.size !== opened.size ||
      afterPath.mtimeNs !== opened.mtimeNs ||
      afterPath.ctimeNs !== opened.ctimeNs ||
      afterPath.mode !== opened.mode ||
      afterPath.nlink !== 1n
    ) {
      throw new Error("Bundle file changed while being read: " + relativePath);
    }
    return buffer.subarray(0, expectedSize);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function expectedPayloadFiles(version, profile) {
  const inventory = packedInventory(profile);
  return [
    "README.md",
    ...(profile === BUNDLE_PROFILE_V12 ||
    profile === BUNDLE_PROFILE_V13 ||
    profile === BUNDLE_PROFILE_V14 ||
    profile === BUNDLE_PROFILE_V15 ||
    profile === BUNDLE_PROFILE_V16 ||
    profile === BUNDLE_PROFILE_V17
      ? ["docs/cohort-audit.md"]
      : []),
    "docs/publisher-pilot-quickstart.md",
    ...(profile === BUNDLE_PROFILE_V12 ||
    profile === BUNDLE_PROFILE_V13 ||
    profile === BUNDLE_PROFILE_V14 ||
    profile === BUNDLE_PROFILE_V15 ||
    profile === BUNDLE_PROFILE_V16 ||
    profile === BUNDLE_PROFILE_V17
      ? ["docs/publisher-recruitment.md"]
      : []),
    ...(profile === BUNDLE_PROFILE_V13 ||
    profile === BUNDLE_PROFILE_V14 ||
    profile === BUNDLE_PROFILE_V15 ||
    profile === BUNDLE_PROFILE_V16 ||
    profile === BUNDLE_PROFILE_V17
      ? ["docs/publisher-prospect-review.md"]
      : []),
    ...(profile === BUNDLE_PROFILE_V14 ||
    profile === BUNDLE_PROFILE_V15 ||
    profile === BUNDLE_PROFILE_V16 ||
    profile === BUNDLE_PROFILE_V17
      ? ["docs/publisher-send-decision-preparation.md"]
      : []),
    ...(profile === BUNDLE_PROFILE_V15 ||
    profile === BUNDLE_PROFILE_V16 ||
    profile === BUNDLE_PROFILE_V17
      ? ["docs/publisher-send-decision-recording.md"]
      : []),
    "docs/supported-environment.md",
    "docs/flows/mwa-authorize.md",
    "docs/flows/mwa-reject.md",
    "docs/flows/mwa-sign-message.md",
    "docs/flows/mwa-siws.md",
    "launchrig-" + version + ".tgz",
    "schemas/launchrig-publisher-bundle.schema.json",
    ...inventory.templates,
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
  const runtimeFileAllowed = (inventory.runtimeFiles ?? []).includes(relativePath);
  if (
    [".git", ".launchrig", ".superstack", "apps", "fixtures", "test"].includes(rootDirectory) ||
    (rootDirectory === "scripts" && !runtimeFileAllowed) ||
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
    inventory.templates.includes(relativePath) ||
    inventory.actionFiles.includes(relativePath) ||
    runtimeFileAllowed
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

  if (
    manifest.profile !== BUNDLE_PROFILE_V14 &&
    manifest.profile !== BUNDLE_PROFILE_V15 &&
    manifest.profile !== BUNDLE_PROFILE_V16 &&
    manifest.profile !== BUNDLE_PROFILE_V17
  ) {
    const unexpectedV14 = PACKED_COMPILED_ADDITIONS_V14_ONLY.find((entry) => entries.has(entry));
    if (unexpectedV14) {
      throw new Error("LaunchRig package contains an RC14 file outside its historical profile: " + unexpectedV14);
    }
  }

  if (
    manifest.profile !== BUNDLE_PROFILE_V15 &&
    manifest.profile !== BUNDLE_PROFILE_V16 &&
    manifest.profile !== BUNDLE_PROFILE_V17
  ) {
    const unexpectedV15 = PACKED_COMPILED_ADDITIONS_V15_ONLY.find((entry) => entries.has(entry));
    if (unexpectedV15) {
      throw new Error("LaunchRig package contains an RC15 file outside its historical profile: " + unexpectedV15);
    }
  }

  if (manifest.profile !== BUNDLE_PROFILE_V16 && manifest.profile !== BUNDLE_PROFILE_V17) {
    const unexpectedV16 = PACKED_COMPILED_ADDITIONS_V16_ONLY.find((entry) => entries.has(entry));
    if (unexpectedV16) {
      throw new Error("LaunchRig package contains an RC16 file outside its historical profile: " + unexpectedV16);
    }
  }

  if (manifest.profile === BUNDLE_PROFILE_V16 || manifest.profile === BUNDLE_PROFILE_V17) {
    for (const required of [
      ...PACKED_COMPILED_ADDITIONS_V8,
      ...PACKED_COMPILED_ADDITIONS_V11_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V12_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V13_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V14_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V15_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V16_ONLY,
    ]) {
      if (!entries.has(required)) {
        const label = manifest.profile === BUNDLE_PROFILE_V17 ? "RC17" : "RC16";
        throw new Error("LaunchRig package " + label + " is missing " + required + ".");
      }
    }
  } else if (manifest.profile === BUNDLE_PROFILE_V15) {
    for (const required of [
      ...PACKED_COMPILED_ADDITIONS_V8,
      ...PACKED_COMPILED_ADDITIONS_V11_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V12_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V13_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V14_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V15_ONLY,
    ]) {
      if (!entries.has(required)) {
        throw new Error("LaunchRig package RC15 is missing " + required + ".");
      }
    }
  } else if (manifest.profile === BUNDLE_PROFILE_V14) {
    for (const required of [
      ...PACKED_COMPILED_ADDITIONS_V8,
      ...PACKED_COMPILED_ADDITIONS_V11_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V12_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V13_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V14_ONLY,
    ]) {
      if (!entries.has(required)) {
        throw new Error("LaunchRig package RC14 is missing " + required + ".");
      }
    }
  } else if (manifest.profile === BUNDLE_PROFILE_V13) {
    for (const required of [
      ...PACKED_COMPILED_ADDITIONS_V8,
      ...PACKED_COMPILED_ADDITIONS_V11_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V12_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V13_ONLY,
    ]) {
      if (!entries.has(required)) {
        throw new Error("LaunchRig package RC13 is missing " + required + ".");
      }
    }
  } else if (manifest.profile === BUNDLE_PROFILE_V12) {
    for (const required of [
      ...PACKED_COMPILED_ADDITIONS_V8,
      ...PACKED_COMPILED_ADDITIONS_V11_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V12_ONLY,
    ]) {
      if (!entries.has(required)) {
        throw new Error("LaunchRig package RC12 is missing " + required + ".");
      }
    }
    const unexpected = PACKED_COMPILED_ADDITIONS_V13_ONLY.find((entry) => entries.has(entry));
    if (unexpected) {
      throw new Error("LaunchRig package contains an RC13 file outside its historical profile: " + unexpected);
    }
  } else if (manifest.profile === BUNDLE_PROFILE_V11) {
    for (const required of [...PACKED_COMPILED_ADDITIONS_V8, ...PACKED_COMPILED_ADDITIONS_V11_ONLY]) {
      if (!entries.has(required)) {
        throw new Error("LaunchRig package RC11 is missing " + required + ".");
      }
    }
    const unexpected = [
      ...PACKED_COMPILED_ADDITIONS_V12_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V13_ONLY,
    ].find((entry) => entries.has(entry));
    if (unexpected) {
      throw new Error("LaunchRig package contains an RC12 file outside its historical profile: " + unexpected);
    }
  } else if (
    manifest.profile === BUNDLE_PROFILE_V10 ||
    manifest.profile === BUNDLE_PROFILE_V9 ||
    manifest.profile === BUNDLE_PROFILE_V8
  ) {
    for (const required of PACKED_COMPILED_ADDITIONS_V8) {
      if (!entries.has(required)) {
        throw new Error("LaunchRig package scope-capable profile is missing " + required + ".");
      }
    }
    const unexpected = [
      ...PACKED_COMPILED_ADDITIONS_V11_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V12_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V13_ONLY,
    ].find((entry) => entries.has(entry));
    if (unexpected) {
      throw new Error("LaunchRig package contains an RC11 file outside its historical profile: " + unexpected);
    }
  } else if (manifest.profile === BUNDLE_PROFILE_V7) {
    for (const required of PACKED_COMPILED_ADDITIONS_V7) {
      if (!entries.has(required)) {
        throw new Error("LaunchRig package RC7 is missing " + required + ".");
      }
    }
    const unexpected = [
      ...PACKED_COMPILED_ADDITIONS_V8_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V11_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V12_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V13_ONLY,
    ].find((entry) => entries.has(entry));
    if (unexpected) {
      throw new Error("LaunchRig package contains an RC8 file outside its historical profile: " + unexpected);
    }
  } else {
    const unexpected = [
      ...PACKED_COMPILED_ADDITIONS_V8,
      ...PACKED_COMPILED_ADDITIONS_V11_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V12_ONLY,
      ...PACKED_COMPILED_ADDITIONS_V13_ONLY,
    ].find((entry) => entries.has(entry));
    if (unexpected) {
      throw new Error("LaunchRig package contains a newer release file outside its historical profile: " + unexpected);
    }
  }

  for (const [label, expected, prefix] of [
    ["documentation", inventory.documents, "package/docs/"],
    ["schema", inventory.schemas, "package/schemas/"],
    ["template", inventory.templates, "package/templates/"],
    ["runtime verifier", inventory.runtimeFiles ?? [], "package/scripts/"],
  ]) {
    const actual = [...entries.keys()]
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice("package/".length))
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
      throw new Error("LaunchRig package " + label + " inventory does not match the release allowlist.");
    }
  }
  const actualActionFiles = [...entries.keys()]
    .filter(
      (entry) =>
        entry === "package/action.yml" ||
        entry.startsWith("package/action/") ||
        entry.startsWith("package/examples/"),
    )
    .map((entry) => entry.slice("package/".length))
    .sort();
  if (JSON.stringify(actualActionFiles) !== JSON.stringify([...inventory.actionFiles].sort())) {
    throw new Error("LaunchRig package Action inventory does not match the release allowlist.");
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
  const expectedRehearsalChecks =
    manifest.profile === BUNDLE_PROFILE_V17
      ? REHEARSAL_CHECKS_V17
      : manifest.profile === BUNDLE_PROFILE_V16
        ? REHEARSAL_CHECKS_V16
        : manifest.profile === BUNDLE_PROFILE_V15
          ? REHEARSAL_CHECKS_V15
          : manifest.profile === BUNDLE_PROFILE_V14
            ? REHEARSAL_CHECKS_V14
            : manifest.profile === BUNDLE_PROFILE_V13
              ? REHEARSAL_CHECKS_V13
              : manifest.profile === BUNDLE_PROFILE_V12
                ? REHEARSAL_CHECKS_V12
                : manifest.profile === BUNDLE_PROFILE_V11
                  ? REHEARSAL_CHECKS_V11
                  : manifest.profile === BUNDLE_PROFILE_V10
                    ? REHEARSAL_CHECKS_V10
                    : manifest.profile === BUNDLE_PROFILE_V9
                      ? REHEARSAL_CHECKS_V9
                      : manifest.profile === BUNDLE_PROFILE_V8
                        ? REHEARSAL_CHECKS_V8
                        : manifest.profile === BUNDLE_PROFILE_V7
                          ? REHEARSAL_CHECKS_V7
                          : LEGACY_REHEARSAL_CHECKS;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== BUNDLE_KIND ||
    ![
      BUNDLE_PROFILE_V1,
      BUNDLE_PROFILE_V2,
      BUNDLE_PROFILE_V3,
      BUNDLE_PROFILE_V4,
      BUNDLE_PROFILE_V5,
      BUNDLE_PROFILE_V6,
      BUNDLE_PROFILE_V7,
      BUNDLE_PROFILE_V8,
      BUNDLE_PROFILE_V9,
      BUNDLE_PROFILE_V10,
      BUNDLE_PROFILE_V11,
      BUNDLE_PROFILE_V12,
      BUNDLE_PROFILE_V13,
      BUNDLE_PROFILE_V14,
      BUNDLE_PROFILE_V15,
      BUNDLE_PROFILE_V16,
      BUNDLE_PROFILE_V17,
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
    JSON.stringify(manifest.consumerRehearsal.checks) !== JSON.stringify(expectedRehearsalChecks)
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
  const expectedPaths = expectedPayloadFiles(manifest.launchRigVersion, manifest.profile);
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

async function verifyPublisherBundleDetails(directory, expectedRootIdentity) {
  const requestedRoot = path.resolve(directory);
  const rootMetadata = await lstat(requestedRoot, { bigint: true });
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Bundle root must be a non-symlink directory.");
  }
  const bundleRoot = await realpath(requestedRoot);
  const resolvedRootMetadata = await lstat(bundleRoot, { bigint: true });
  if (
    resolvedRootMetadata.isSymbolicLink() ||
    !resolvedRootMetadata.isDirectory() ||
    !sameFileIdentity(rootMetadata, resolvedRootMetadata) ||
    (expectedRootIdentity &&
      (resolvedRootMetadata.dev !== expectedRootIdentity.dev ||
        resolvedRootMetadata.ino !== expectedRootIdentity.ino))
  ) {
    throw new Error("Bundle root changed while being resolved.");
  }
  const initialTree = await captureBundleTree(bundleRoot);
  if (!treeRootMatchesMetadata(initialTree, resolvedRootMetadata)) {
    throw new Error("Bundle root changed before its tree was captured.");
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

  const actualFiles = initialTree.files;
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
  const finalTree = await captureBundleTree(bundleRoot);
  const finalRootMetadata = await lstat(requestedRoot, { bigint: true });
  const finalResolvedRootMetadata = await lstat(bundleRoot, { bigint: true });
  if (
    finalRootMetadata.isSymbolicLink() ||
    !finalRootMetadata.isDirectory() ||
    !sameMetadata(rootMetadata, finalRootMetadata, "directory") ||
    finalResolvedRootMetadata.isSymbolicLink() ||
    !finalResolvedRootMetadata.isDirectory() ||
    !sameMetadata(resolvedRootMetadata, finalResolvedRootMetadata, "directory") ||
    !treeRootMatchesMetadata(finalTree, finalResolvedRootMetadata) ||
    JSON.stringify(initialTree) !== JSON.stringify(finalTree)
  ) {
    throw new Error("Bundle tree changed while being verified.");
  }
  const snapshot = Object.freeze({
    profile: manifest.profile,
    bundleId: manifest.bundleId,
    manifestSha256: sha256(manifestBytes),
    sha256SumsSha256: sha256(sums),
    packageSha256: manifest.package.sha256,
  });
  if (
    !/^sha256:[a-f0-9]{64}$/.test(snapshot.bundleId) ||
    !/^[a-f0-9]{64}$/.test(snapshot.manifestSha256) ||
    !/^[a-f0-9]{64}$/.test(snapshot.sha256SumsSha256) ||
    !/^[a-f0-9]{64}$/.test(snapshot.packageSha256)
  ) {
    throw new Error("Verified bundle snapshot contains an invalid digest.");
  }
  return { manifest, snapshot };
}

export async function verifyPublisherBundle(directory) {
  return (await verifyPublisherBundleDetails(directory)).manifest;
}

export async function verifyPublisherBundleSnapshot(directory) {
  return (await verifyPublisherBundleDetails(directory)).snapshot;
}

export async function verifyPublisherBundleAtIdentity(directory, expectedRootIdentity) {
  if (
    !expectedRootIdentity ||
    typeof expectedRootIdentity !== "object" ||
    typeof expectedRootIdentity.dev !== "bigint" ||
    typeof expectedRootIdentity.ino !== "bigint"
  ) {
    throw new Error("Expected bundle root identity is invalid.");
  }
  return (await verifyPublisherBundleDetails(directory, expectedRootIdentity)).manifest;
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
