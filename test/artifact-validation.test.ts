import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

interface ArtifactIdentity {
  size: number;
  sha256: string;
}

interface ArtifactValidation extends ArtifactIdentity {
  status: "validated";
  contract: string;
}

interface ArtifactClassification {
  status: "validated" | "candidate";
  contract: string;
  expected: ArtifactIdentity;
  actual: ArtifactIdentity;
}

const validationModule = (await import(
  pathToFileURL(path.join(process.cwd(), "scripts", "artifact-validation.js")).href
)) as {
  candidateArtifactName(artifactName: string, sha256: string): string;
  classifyArtifact(actual: ArtifactIdentity, expected: ArtifactIdentity, contract: string): ArtifactClassification;
  validateArtifact(actual: ArtifactIdentity, expected: ArtifactIdentity, contract: string): ArtifactValidation;
};
const { candidateArtifactName, classifyArtifact, validateArtifact } = validationModule;

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

test("artifact validation returns a provenance-ready validated record", () => {
  assert.deepEqual(validateArtifact({ size: 42, sha256: SHA }, { size: 42, sha256: SHA }, "fixture.json"), {
    status: "validated",
    contract: "fixture.json",
    size: 42,
    sha256: SHA,
  });
});

test("artifact validation rejects size and digest mismatches before replacement", () => {
  assert.throws(
    () => validateArtifact({ size: 43, sha256: OTHER_SHA }, { size: 42, sha256: SHA }, "fixture.json"),
    (error: unknown) => {
      assert.match(String(error), /size 43 \(expected 42\)/);
      assert.match(String(error), /sha256 b{64} \(expected a{64}\)/);
      assert.match(String(error), /stable artifact was not replaced/i);
      return true;
    },
  );
});

test("artifact validation rejects malformed contracts", () => {
  assert.throws(
    () => validateArtifact({ size: 42, sha256: SHA }, { size: 0, sha256: "invalid" }, "fixture.json"),
    /must declare a positive size and lowercase SHA-256 digest/,
  );
});

test("artifact classification preserves expected and actual candidate identities", () => {
  assert.deepEqual(classifyArtifact({ size: 42, sha256: OTHER_SHA }, { size: 42, sha256: SHA }, "fixture.json"), {
    status: "candidate",
    contract: "fixture.json",
    expected: { size: 42, sha256: SHA },
    actual: { size: 42, sha256: OTHER_SHA },
  });
});

test("artifact classification marks an exact identity as validated", () => {
  assert.equal(classifyArtifact({ size: 42, sha256: SHA }, { size: 42, sha256: SHA }, "fixture.json").status, "validated");
});

test("candidate artifact names include the full content digest", () => {
  assert.equal(
    candidateArtifactName("launchrig-fixture-v0.1.0-arm64-release.apk", OTHER_SHA),
    "launchrig-fixture-v0.1.0-arm64-release.candidate-" + OTHER_SHA + ".apk",
  );
});

test("Mock MWA validates its staged APK before replacing the stable artifact", async () => {
  const source = await readFile(path.join(process.cwd(), "scripts", "build-mock-mwa-fixture.mjs"), "utf8");
  const validationIndex = source.indexOf("const validation = validateArtifact(");
  const replacementIndex = source.indexOf("await rename(temporaryApk, targetApk);");

  assert.ok(validationIndex >= 0);
  assert.ok(replacementIndex > validationIndex);
});

test("dApp builder classifies staged bytes and keeps a candidate off the stable alias", async () => {
  const source = await readFile(path.join(process.cwd(), "scripts", "build-fixture-dapp.mjs"), "utf8");
  const sourceSnapshotIndex = source.indexOf("const fixtureSource = await fixtureSourceSnapshot();");
  const frozenInstallIndex = source.indexOf('await run(pnpm, ["install", "--frozen-lockfile", "--force"]');
  const sourceVerificationIndex = source.indexOf("assertUnchangedSource(fixtureSource, await fixtureSourceSnapshot());");
  const artifactStagingIndex = source.indexOf("await unlink(temporaryApk)");

  assert.ok(sourceSnapshotIndex >= 0);
  assert.ok(frozenInstallIndex > sourceSnapshotIndex);
  assert.ok(sourceVerificationIndex > frozenInstallIndex);
  assert.ok(artifactStagingIndex > sourceVerificationIndex);
  assert.match(source, /"status", "--porcelain=v1", "--untracked-files=all"/);
  assert.match(source, /"ls-files", "-z", "--cached", "--others", "--exclude-standard"/);
  assert.match(source, /sourceStatusSha256/);
  assert.match(source, /sourceTreeSha256/);
  assert.match(source, /\.\.\.fixtureSource/);
  assert.doesNotMatch(source, /installedModulesPath/);
  assert.match(source, /fixtureManifest\.validatedArtifact\s*\?\s*classifyArtifact\(/);
  assert.match(source, /status: "candidate"[\s\S]*expected: null[\s\S]*actual: actualArtifact/);
  assert.match(source, /classification\.status === "validated"\s*\? targetApk/);
  assert.match(source, /candidateArtifactName\(artifactName, digest\)/);
  assert.match(source, /status: classification\.status/);
  assert.match(source, /expected: classification\.expected/);
  assert.match(source, /actual: classification\.actual/);
  assert.match(source, /stable validated artifact unchanged/);
});

test("Mock MWA builder rejects nonignored source changes before build setup", async () => {
  const source = await readFile(path.join(process.cwd(), "scripts", "build-mock-mwa-fixture.mjs"), "utf8");
  const statusIndex = source.indexOf('"--porcelain=v1"');
  const ignoredPolicyIndex = source.indexOf('"--untracked-files=all"');
  const buildSetupIndex = source.indexOf("const sdkRoot = await findDirectory(");

  assert.ok(statusIndex >= 0);
  assert.ok(ignoredPolicyIndex > statusIndex);
  assert.ok(buildSetupIndex > ignoredPolicyIndex);
});
