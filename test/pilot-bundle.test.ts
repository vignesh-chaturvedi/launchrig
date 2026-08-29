import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

interface PayloadEntry {
  path: string;
  sizeBytes: number;
  sha256: string;
}

interface BundleManifest {
  schemaVersion: number;
  kind: string;
  profile: string;
  bundleId: string;
  launchRigVersion: string;
  package: { path: string; sha256: string };
  consumerRehearsal: { status: string; checks: string[]; deviceOrWalletTested: boolean };
  sourceVerification: { status: string; checks: string[] };
  claims: Record<string, string>;
  grantReady: boolean;
  files: PayloadEntry[];
}

interface BundleLibrary {
  collectPayloadEntries(directory: string): Promise<PayloadEntry[]>;
  createPublisherManifest(input: {
    profile?: string;
    launchRigVersion: string;
    gitCommit: string;
    lockfileSha256: string;
    nodeEngine: string;
    packageManager: string;
    packagePath: string;
    files: PayloadEntry[];
  }): BundleManifest;
  parseBundleArguments(args: string[]): { help: boolean; output?: string };
  renderSha256Sums(files: PayloadEntry[]): string;
  resolveNewOutputDirectory(output: string): Promise<{ parentDirectory: string; outputDirectory: string }>;
}

interface BundleVerifier {
  verifyPublisherBundle(directory: string): Promise<BundleManifest>;
}

const bundleLibrary = (await import(
  pathToFileURL(path.join(process.cwd(), "scripts", "pilot-bundle-lib.mjs")).href
)) as BundleLibrary;
const bundleVerifier = (await import(
  pathToFileURL(path.join(process.cwd(), "scripts", "verify-pilot-bundle.mjs")).href
)) as BundleVerifier;

const VERSION = "0.1.0";
const ARCHIVE = "launchrig-" + VERSION + ".tgz";
const BUNDLE_PROFILE_V1 = "phase-2a-publisher-rc-v1";
const BUNDLE_PROFILE_V2 = "phase-2b-publisher-rc-v2";
const BUNDLE_PROFILE_V3 = "phase-2c-publisher-rc-v3";
const BUNDLE_PROFILE_V4 = "phase-3-foundation-rc-v4";
const BUNDLE_PROFILE_V5 = "phase-3-config-parity-rc-v5";
const BUNDLE_PROFILE_V6 = "phase-3-validation-action-rc-v6";
const BUNDLE_PROFILE_V7 = "phase-2d-publisher-readiness-rc-v7";
const BUNDLE_PROFILE_V8 = "phase-2e-consent-scope-rc-v8";
const LEGACY_REHEARSAL_CHECKS = [
  "offline-package-install",
  "installed-version-match",
  "installed-help-contract",
  "pilot-timer-start",
  "starter-generation",
  "starter-validation",
  "device-free-preflight-refusal",
];
const V7_REHEARSAL_CHECKS = [
  ...LEGACY_REHEARSAL_CHECKS,
  "device-free-pilot-policy-lint-refusal",
];
const V8_REHEARSAL_CHECKS = [
  ...V7_REHEARSAL_CHECKS,
  "device-free-session-scope-receipt",
];
const REQUIRED_PAYLOADS = [
  "README.md",
  "docs/publisher-pilot-quickstart.md",
  "docs/supported-environment.md",
  "docs/flows/mwa-authorize.md",
  "docs/flows/mwa-reject.md",
  "docs/flows/mwa-sign-message.md",
  "docs/flows/mwa-siws.md",
  ARCHIVE,
  "schemas/launchrig-publisher-bundle.schema.json",
  "templates/defect-evidence.md",
  "templates/pilot-consent.md",
  "templates/pilot-notes.md",
  "templates/publisher-intake.md",
  "templates/sharing-review.md",
];
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
const PACKED_TEMPLATES = [
  "templates/defect-evidence.md",
  "templates/pilot-consent.md",
  "templates/pilot-notes.md",
  "templates/publisher-intake.md",
  "templates/sharing-review.md",
];
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

function tarHeader(name: string, size: number): Buffer {
  assert.ok(Buffer.byteLength(name, "ascii") <= 100);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function collectPinnedYamlFiles(directory: string, prefix = ""): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    const relativePath = path.posix.join(prefix, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Pinned YAML test runtime must not contain symlinks.");
    if (entry.isDirectory()) {
      for (const [nestedPath, bytes] of collectPinnedYamlFiles(absolutePath, relativePath)) {
        files.set(nestedPath, bytes);
      }
      continue;
    }
    if (!entry.isFile() || !lstatSync(absolutePath).isFile()) {
      throw new Error("Pinned YAML test runtime contains an unsupported entry.");
    }
    files.set(relativePath, readFileSync(absolutePath));
  }
  return files;
}

const PINNED_YAML_FILES = collectPinnedYamlFiles(realpathSync(path.join(process.cwd(), "node_modules", "yaml")));

function createTestPackageArchive(
  extraPaths: string[] = [],
  profile = BUNDLE_PROFILE_V8,
  omittedPaths: string[] = [],
): Buffer {
  const inventories = {
    [BUNDLE_PROFILE_V1]: { documents: PACKED_DOCUMENTS_V1, schemas: PACKED_SCHEMAS_V1, actionFiles: [] },
    [BUNDLE_PROFILE_V2]: { documents: PACKED_DOCUMENTS_V2, schemas: PACKED_SCHEMAS_V2, actionFiles: [] },
    [BUNDLE_PROFILE_V3]: { documents: PACKED_DOCUMENTS_V3, schemas: PACKED_SCHEMAS_V3, actionFiles: [] },
    [BUNDLE_PROFILE_V4]: { documents: PACKED_DOCUMENTS_V4, schemas: PACKED_SCHEMAS_V4, actionFiles: [] },
    [BUNDLE_PROFILE_V5]: { documents: PACKED_DOCUMENTS_V5, schemas: PACKED_SCHEMAS_V5, actionFiles: [] },
    [BUNDLE_PROFILE_V6]: {
      documents: PACKED_DOCUMENTS_V6,
      schemas: PACKED_SCHEMAS_V5,
      actionFiles: PACKED_ACTION_FILES_V6,
    },
    [BUNDLE_PROFILE_V7]: {
      documents: PACKED_DOCUMENTS_V6,
      schemas: PACKED_SCHEMAS_V7,
      actionFiles: PACKED_ACTION_FILES_V6,
    },
    [BUNDLE_PROFILE_V8]: {
      documents: PACKED_DOCUMENTS_V6,
      schemas: PACKED_SCHEMAS_V8,
      actionFiles: PACKED_ACTION_FILES_V6,
    },
  };
  const inventory = inventories[profile as keyof typeof inventories];
  if (!inventory) throw new Error("Unsupported synthetic bundle profile.");
  const packedDocuments = inventory.documents;
  const packedSchemas = inventory.schemas;
  const packageMetadata = {
    name: "launchrig",
    version: VERSION,
    private: true,
    bin: { launchrig: "dist/src/cli.js" },
    engines: { node: ">=20.11" },
    scripts: { build: "tsc" },
  };
  const paths = [
    "package/LICENSE",
    "package/README.md",
    "package/dist/src/cli.js",
    "package/dist/src/fixtures/matrix.js",
    "package/package.json",
    ...(profile === BUNDLE_PROFILE_V8
      ? PACKED_COMPILED_ADDITIONS_V8
      : profile === BUNDLE_PROFILE_V7
        ? PACKED_COMPILED_ADDITIONS_V7
        : []),
    ...[...PINNED_YAML_FILES.keys()].map((entry) => "package/dist/node_modules/yaml/" + entry),
    ...packedDocuments.map((entry) => "package/" + entry),
    ...packedSchemas.map((entry) => "package/" + entry),
    ...PACKED_TEMPLATES.map((entry) => "package/" + entry),
    ...inventory.actionFiles.map((entry) => "package/" + entry),
    ...extraPaths,
  ].filter((entry) => !omittedPaths.includes(entry)).sort();
  const blocks: Buffer[] = [];
  for (const archivePath of paths) {
    const yamlPath = archivePath.startsWith("package/dist/node_modules/yaml/")
      ? archivePath.slice("package/dist/node_modules/yaml/".length)
      : undefined;
    const pinnedYamlContent = yamlPath ? PINNED_YAML_FILES.get(yamlPath) : undefined;
    const content =
      pinnedYamlContent ??
      Buffer.from(
          archivePath === "package/package.json"
            ? JSON.stringify(packageMetadata, null, 2) + "\n"
            : "synthetic archive payload for " + archivePath + "\n",
          "utf8",
        );
    blocks.push(tarHeader(archivePath, content.length), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

async function writeSyntheticBundle(
  directory: string,
  extraPayloads: string[] = [],
  archiveBytes: Buffer = createTestPackageArchive(),
  profile = BUNDLE_PROFILE_V8,
): Promise<BundleManifest> {
  for (const relativePath of [...REQUIRED_PAYLOADS, ...extraPayloads]) {
    const target = path.join(directory, ...relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, relativePath === ARCHIVE ? archiveBytes : "synthetic payload for " + relativePath + "\n");
  }
  const files = await bundleLibrary.collectPayloadEntries(directory);
  const manifest = bundleLibrary.createPublisherManifest({
    profile,
    launchRigVersion: VERSION,
    gitCommit: "a".repeat(40),
    lockfileSha256: "b".repeat(64),
    nodeEngine: ">=20.11",
    packageManager: "pnpm@10.34.0",
    packagePath: ARCHIVE,
    files,
  });
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await writeFile(path.join(directory, "SHA256SUMS"), bundleLibrary.renderSha256Sums(files), "utf8");
  return manifest;
}

test("pilot bundle arguments require one explicit output", () => {
  assert.deepEqual(bundleLibrary.parseBundleArguments(["--", "--output", "/private/tmp/launchrig-rc"]), {
    help: false,
    output: "/private/tmp/launchrig-rc",
  });
  assert.deepEqual(bundleLibrary.parseBundleArguments(["--help"]), { help: true, output: undefined });
  assert.throws(() => bundleLibrary.parseBundleArguments([]), /--output is required/);
  assert.throws(() => bundleLibrary.parseBundleArguments(["--force"]), /Unknown pilot bundle argument/);
});

test("pilot bundle output refuses relative, existing, and symlink-parent paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-path-"));
  try {
    await assert.rejects(() => bundleLibrary.resolveNewOutputDirectory("relative-bundle"), /absolute path/);
    const candidate = path.join(directory, "publisher-rc");
    const resolved = await bundleLibrary.resolveNewOutputDirectory(candidate);
    assert.equal(resolved.outputDirectory, path.join(await realpath(directory), "publisher-rc"));
    await mkdir(candidate);
    await assert.rejects(() => bundleLibrary.resolveNewOutputDirectory(candidate), /already exists/);

    const realParent = path.join(directory, "real-parent");
    const linkedParent = path.join(directory, "linked-parent");
    await mkdir(realParent);
    await symlink(realParent, linkedParent, "dir");
    await assert.rejects(
      () => bundleLibrary.resolveNewOutputDirectory(path.join(linkedParent, "publisher-rc")),
      /non-symlink directory/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publisher bundle verifier accepts the strict self-limited handoff contract", async () => {
  for (const profile of [
    BUNDLE_PROFILE_V1,
    BUNDLE_PROFILE_V2,
    BUNDLE_PROFILE_V3,
    BUNDLE_PROFILE_V4,
    BUNDLE_PROFILE_V5,
    BUNDLE_PROFILE_V6,
    BUNDLE_PROFILE_V7,
    BUNDLE_PROFILE_V8,
  ]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-valid-"));
    try {
      const archive = createTestPackageArchive([], profile);
      const expected = await writeSyntheticBundle(directory, [], archive, profile);
      const verified = await bundleVerifier.verifyPublisherBundle(directory);
      assert.equal(verified.profile, profile);
      assert.equal(verified.bundleId, expected.bundleId);
      assert.equal(verified.package.sha256, expected.package.sha256);
      assert.equal(verified.consumerRehearsal.status, "passed");
      assert.equal(verified.consumerRehearsal.deviceOrWalletTested, false);
      assert.deepEqual(
        verified.consumerRehearsal.checks,
        profile === BUNDLE_PROFILE_V8
          ? V8_REHEARSAL_CHECKS
          : profile === BUNDLE_PROFILE_V7
            ? V7_REHEARSAL_CHECKS
            : LEGACY_REHEARSAL_CHECKS,
      );
      assert.deepEqual(verified.sourceVerification, {
        status: "passed",
        checks: [
          "package-manager-version",
          "frozen-offline-dependency-restore",
          "typecheck",
          "test-suite",
          "package-smoke",
        ],
      });
      assert.ok(Object.values(verified.claims).every((claim) => claim === "not-established"));
      assert.equal(verified.grantReady, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("publisher bundle profiles keep older package inventories frozen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-v3-frozen-"));
  try {
    const archive = createTestPackageArchive(
      ["package/docs/phase-3-foundation.md"],
      BUNDLE_PROFILE_V3,
    );
    await writeSyntheticBundle(directory, [], archive, BUNDLE_PROFILE_V3);
    await assert.rejects(
      () => bundleVerifier.verifyPublisherBundle(directory),
      /outside the release allowlist/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publisher bundle v4 rejects config parity files added by v5", async () => {
  for (const addedPath of [
    "package/docs/config-v1-compatibility.md",
    "package/schemas/fixtures/launchrig-config-v1.conformance.json",
  ]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-v4-frozen-"));
    try {
      const archive = createTestPackageArchive([addedPath], BUNDLE_PROFILE_V4);
      await writeSyntheticBundle(directory, [], archive, BUNDLE_PROFILE_V4);
      await assert.rejects(
        () => bundleVerifier.verifyPublisherBundle(directory),
        /outside the release allowlist/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("publisher bundle v4 requires the foundation guide and rule catalog schema", async () => {
  for (const omittedPath of [
    "package/docs/phase-3-foundation.md",
    "package/schemas/launchrig-core-rule-catalog.schema.json",
  ]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-v4-required-"));
    try {
      const archive = createTestPackageArchive([], BUNDLE_PROFILE_V4, [omittedPath]);
      await writeSyntheticBundle(directory, [], archive, BUNDLE_PROFILE_V4);
      await assert.rejects(
        () => bundleVerifier.verifyPublisherBundle(directory),
        /inventory does not match the release allowlist/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("publisher bundle v5 requires the config compatibility guide and conformance corpus", async () => {
  for (const omittedPath of [
    "package/docs/config-v1-compatibility.md",
    "package/schemas/fixtures/launchrig-config-v1.conformance.json",
  ]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-v5-required-"));
    try {
      const archive = createTestPackageArchive([], BUNDLE_PROFILE_V5, [omittedPath]);
      await writeSyntheticBundle(directory, [], archive, BUNDLE_PROFILE_V5);
      await assert.rejects(
        () => bundleVerifier.verifyPublisherBundle(directory),
        /inventory does not match the release allowlist/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("publisher bundle v5 rejects validation Action files added by v6", async () => {
  for (const addedPath of [
    "package/docs/github-action.md",
    ...PACKED_ACTION_FILES_V6.map((entry) => "package/" + entry),
  ]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-v5-frozen-"));
    try {
      const archive = createTestPackageArchive([addedPath], BUNDLE_PROFILE_V5);
      await writeSyntheticBundle(directory, [], archive, BUNDLE_PROFILE_V5);
      await assert.rejects(
        () => bundleVerifier.verifyPublisherBundle(directory),
        /outside the release allowlist/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("publisher bundle v6 requires the validation Action guide, runner, metadata, and example", async () => {
  for (const omittedPath of [
    "package/docs/github-action.md",
    ...PACKED_ACTION_FILES_V6.map((entry) => "package/" + entry),
  ]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-v6-required-"));
    try {
      const archive = createTestPackageArchive([], BUNDLE_PROFILE_V6, [omittedPath]);
      await writeSyntheticBundle(directory, [], archive, BUNDLE_PROFILE_V6);
      await assert.rejects(
        () => bundleVerifier.verifyPublisherBundle(directory),
        /inventory does not match the release allowlist/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("publisher bundle v7 requires its binding command and receipt schema inventory", async () => {
  for (const omittedPath of [
    ...PACKED_COMPILED_ADDITIONS_V7,
    "package/schemas/launchrig-pilot-evidence-binding-receipt.schema.json",
  ]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-v7-required-"));
    try {
      const archive = createTestPackageArchive([], BUNDLE_PROFILE_V7, [omittedPath]);
      await writeSyntheticBundle(directory, [], archive, BUNDLE_PROFILE_V7);
      await assert.rejects(
        () => bundleVerifier.verifyPublisherBundle(directory),
        /RC7 is missing|inventory does not match the release allowlist/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("publisher bundle v6 rejects v7-only binding command and receipt schema inventory", async () => {
  for (const addedPath of [
    ...PACKED_COMPILED_ADDITIONS_V7,
    "package/schemas/launchrig-pilot-evidence-binding-receipt.schema.json",
  ]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-v6-frozen-"));
    try {
      const archive = createTestPackageArchive([addedPath], BUNDLE_PROFILE_V6);
      await writeSyntheticBundle(directory, [], archive, BUNDLE_PROFILE_V6);
      await assert.rejects(
        () => bundleVerifier.verifyPublisherBundle(directory),
        /outside the release allowlist|outside its historical profile/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("publisher bundle v8 requires its session scope command and schema inventory", async () => {
  for (const omittedPath of [
    ...PACKED_COMPILED_ADDITIONS_V8_ONLY,
    "package/schemas/launchrig-pilot-session-scope.schema.json",
    "package/schemas/launchrig-pilot-session-scope-receipt.schema.json",
  ]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-v8-required-"));
    try {
      const archive = createTestPackageArchive([], BUNDLE_PROFILE_V8, [omittedPath]);
      await writeSyntheticBundle(directory, [], archive, BUNDLE_PROFILE_V8);
      await assert.rejects(
        () => bundleVerifier.verifyPublisherBundle(directory),
        /RC8 is missing|inventory does not match the release allowlist/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("publisher bundle v7 rejects v8-only session scope inventory", async () => {
  for (const addedPath of [
    ...PACKED_COMPILED_ADDITIONS_V8_ONLY,
    "package/schemas/launchrig-pilot-session-scope.schema.json",
    "package/schemas/launchrig-pilot-session-scope-receipt.schema.json",
  ]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-v7-frozen-"));
    try {
      const archive = createTestPackageArchive([addedPath], BUNDLE_PROFILE_V7);
      await writeSyntheticBundle(directory, [], archive, BUNDLE_PROFILE_V7);
      await assert.rejects(
        () => bundleVerifier.verifyPublisherBundle(directory),
        /outside the release allowlist|RC8 file outside its historical profile/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("publisher bundle verifier rejects one-byte payload tampering", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-tamper-"));
  try {
    await writeSyntheticBundle(directory);
    await writeFile(path.join(directory, ARCHIVE), "changed archive bytes\n", "utf8");
    await assert.rejects(() => bundleVerifier.verifyPublisherBundle(directory), /checksum mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publisher bundle verifier rejects invalid and private package archive content", async () => {
  for (const [label, archive, message] of [
    ["invalid", Buffer.from("not a gzip archive", "utf8"), /not a bounded gzip stream/],
    [
      "private",
      createTestPackageArchive(["package/.launchrig/pilots/evidence.json"]),
      /outside the release allowlist/,
    ],
    [
      "root-fixtures",
      createTestPackageArchive(["package/fixtures/private-pilot.json"]),
      /outside the release allowlist/,
    ],
    [
      "runtime-extra",
      createTestPackageArchive(["package/dist/node_modules/yaml/private.js"]),
      /pinned integrity contract/,
    ],
  ] as const) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-archive-" + label + "-"));
    try {
      await writeSyntheticBundle(directory, [], archive);
      await assert.rejects(() => bundleVerifier.verifyPublisherBundle(directory), message);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("publisher bundle verifier binds valid-looking provenance into the bundle ID", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-provenance-"));
  try {
    await writeSyntheticBundle(directory);
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BundleManifest & {
      source: { gitCommit: string };
    };
    manifest.source.gitCommit = "c".repeat(40);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await assert.rejects(() => bundleVerifier.verifyPublisherBundle(directory), /manifest provenance and payload/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundle quickstart flow links resolve inside the handoff layout", async () => {
  const quickstart = await readFile(path.join(process.cwd(), "docs", "publisher-pilot-quickstart.md"), "utf8");
  const links = [...quickstart.matchAll(/\]\((flows\/[^)]+\.md)\)/g)].map((match) => match[1]);
  assert.deepEqual(links.sort(), [
    "flows/mwa-authorize.md",
    "flows/mwa-reject.md",
    "flows/mwa-sign-message.md",
    "flows/mwa-siws.md",
  ]);
  for (const link of links) assert.ok(REQUIRED_PAYLOADS.includes("docs/" + link));
});

test("publisher bundle verifier rejects unlisted files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-extra-"));
  try {
    await writeSyntheticBundle(directory);
    await writeFile(path.join(directory, ".env"), "SECRET=not-allowed\n", "utf8");
    await assert.rejects(() => bundleVerifier.verifyPublisherBundle(directory), /missing or unlisted files/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publisher bundle verifier rejects private files even when inventoried", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-private-"));
  try {
    await writeSyntheticBundle(directory, [".launchrig/pilots/private-evidence.json"]);
    await assert.rejects(() => bundleVerifier.verifyPublisherBundle(directory), /exact publisher profile allowlist/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publisher bundle verifier rejects payload symlinks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-bundle-symlink-"));
  try {
    await writeSyntheticBundle(directory);
    const target = path.join(directory, "README.md");
    await rm(target);
    await symlink(path.join(directory, ARCHIVE), target);
    await assert.rejects(() => bundleVerifier.verifyPublisherBundle(directory), /symlink/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
