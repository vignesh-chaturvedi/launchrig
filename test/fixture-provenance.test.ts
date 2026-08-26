import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/load.js";

const WORKSPACE = process.cwd();
const MANIFEST_PATH = path.join(WORKSPACE, "fixtures", "launchrig-dapp-v0.2.0.json");
const LOCKFILE_PATH = path.join(WORKSPACE, "apps", "fixture-dapp", "pnpm-lock.yaml");

interface FixtureManifest {
  schemaVersion: number;
  packageName: string;
  versionName: string;
  versionCode: number;
  network: string;
  deepLinks: Record<string, { broken: string; fixed: string }>;
  build: {
    artifactName: string;
    architectures: string[];
    lockfileSha256: string;
  };
  validatedArtifact: {
    size: number;
    sha256: string;
  };
}

interface MockWalletManifest {
  schemaVersion: number;
  source: string;
  commit: string;
  packageName: string;
  artifactName: string;
  authenticationWindowSeconds: number;
  validatedArtifact: { size: number; sha256: string };
}

async function loadManifest(): Promise<FixtureManifest> {
  return JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as FixtureManifest;
}

test("controlled dApp provenance pins source inputs and the validated artifact", async () => {
  const manifest = await loadManifest();
  const lockfile = await readFile(LOCKFILE_PATH);

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.packageName, "dev.launchrig.fixture");
  assert.equal(manifest.versionName, "0.2.0");
  assert.equal(manifest.versionCode, 2);
  assert.equal(manifest.network, "devnet");
  assert.deepEqual(manifest.deepLinks, {
    "rejection-recovery": {
      broken: "launchrig://fixture/rejection?variant=broken",
      fixed: "launchrig://fixture/rejection?variant=fixed",
    },
    "stale-authorization-recovery": {
      broken: "launchrig://fixture/stale-authorization?variant=broken",
      fixed: "launchrig://fixture/stale-authorization?variant=fixed",
    },
    "process-death-recovery": {
      broken: "launchrig://fixture/process-death?variant=broken",
      fixed: "launchrig://fixture/process-death?variant=fixed",
    },
  });
  assert.deepEqual(manifest.build.architectures, ["arm64-v8a"]);
  assert.equal(createHash("sha256").update(lockfile).digest("hex"), manifest.build.lockfileSha256);
  assert.match(manifest.validatedArtifact.sha256, /^[a-f0-9]{64}$/);
  assert.ok(manifest.validatedArtifact.size > 0);
});

test("controlled matrix configs reference the provenance artifact", async () => {
  const manifest = await loadManifest();
  const configs = await Promise.all(
    ["rejection", "stale-authorization", "process-death"].flatMap((scenario) =>
      ["broken", "fixed"].map((variant) =>
        loadConfig(path.join(WORKSPACE, "launchrig-fixture-" + scenario + "-" + variant + ".yml")),
      ),
    ),
  );

  for (const config of configs) {
    assert.equal(config.project.packageName, manifest.packageName);
    assert.equal(config.target.network, manifest.network);
    assert.equal(path.basename(config.resolvedApk ?? ""), manifest.build.artifactName);
  }
});

test("cached controlled dApp matches the physically validated artifact", async (context) => {
  const manifest = await loadManifest();
  const artifactPath = path.join(WORKSPACE, ".launchrig", "cache", "apks", manifest.build.artifactName);
  let artifact: Buffer;
  try {
    artifact = await readFile(artifactPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      context.skip("cached APK is not present on this host");
      return;
    }
    throw error;
  }

  assert.equal(artifact.byteLength, manifest.validatedArtifact.size);
  assert.equal(createHash("sha256").update(artifact).digest("hex"), manifest.validatedArtifact.sha256);
});

test("current Mock MWA source and cached artifact are pinned", async (context) => {
  const source = await readFile(path.join(WORKSPACE, "fixtures", "mock-mwa-main.json"), "utf8");
  const manifest = JSON.parse(source) as MockWalletManifest;

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.source, "https://github.com/solana-mobile/mock-mwa-wallet.git");
  assert.match(manifest.commit, /^[a-f0-9]{40}$/);
  assert.equal(manifest.packageName, "com.solana.mwallet");
  assert.equal(manifest.authenticationWindowSeconds, 900);

  const artifactPath = path.join(WORKSPACE, ".launchrig", "cache", "apks", manifest.artifactName);
  let artifact: Buffer;
  try {
    artifact = await readFile(artifactPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      context.skip("cached Mock MWA APK is not present on this host");
      return;
    }
    throw error;
  }

  assert.equal(artifact.byteLength, manifest.validatedArtifact.size);
  assert.equal(createHash("sha256").update(artifact).digest("hex"), manifest.validatedArtifact.sha256);
});
