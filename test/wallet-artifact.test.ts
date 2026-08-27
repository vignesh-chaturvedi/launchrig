import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyManagedWalletArtifact } from "../src/security/wallet-artifact.js";

test("managed wallet installation rejects bytes outside the pinned artifact contract", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-wallet-artifact-"));
  try {
    const apk = path.join(directory, "wallet.apk");
    await writeFile(apk, "untrusted wallet bytes", "utf8");
    const verification = await verifyManagedWalletArtifact("com.solana.mwallet", apk);
    assert.equal(verification.valid, false);
    assert.match(verification.expectedSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(
      verification.actualSha256,
      createHash("sha256").update("untrusted wallet bytes").digest("hex"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed wallet installation rejects packages outside the allowlist", async () => {
  const verification = await verifyManagedWalletArtifact("com.publisher.wallet", "/not/read");
  assert.deepEqual(verification, { valid: false });
});

test("managed wallet pins stay synchronized with the tracked fixture contracts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-wallet-contracts-"));
  try {
    const invalidApk = path.join(directory, "invalid.apk");
    await writeFile(invalidApk, "invalid", "utf8");
    const mockManifest = JSON.parse(
      await readFile(path.join(process.cwd(), "fixtures", "mock-mwa-main.json"), "utf8"),
    ) as { packageName: string; validatedArtifact: { sha256: string } };
    const referenceManifest = JSON.parse(
      await readFile(path.join(process.cwd(), "fixtures", "mwa-v2.2.0.json"), "utf8"),
    ) as { fixtures: Array<{ packageName: string; sha256: string }> };
    const referenceWallet = referenceManifest.fixtures.find(
      (fixture) => fixture.packageName === "com.solana.mobilewalletadapter.fakewallet",
    );
    assert.equal(
      (await verifyManagedWalletArtifact(mockManifest.packageName, invalidApk)).expectedSha256,
      mockManifest.validatedArtifact.sha256,
    );
    assert.equal(
      (await verifyManagedWalletArtifact("com.solana.mobilewalletadapter.fakewallet", invalidApk)).expectedSha256,
      referenceWallet?.sha256,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
