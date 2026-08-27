import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MANAGED_WALLET_SHA256: Readonly<Record<string, string>> = {
  "com.solana.mwallet": "b9b28b4936f388f615febc493e0af5c7e8c40002de4a3cddbef4f52315a9ef3b",
  "com.solana.mobilewalletadapter.fakewallet":
    "8951e22a09a91fb8525805e300d02b5685e03f7b4853d4295b9057c461ab59a2",
};

export function managedWalletExpectedSha256(packageName: string): string | undefined {
  return MANAGED_WALLET_SHA256[packageName];
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filePath);
    input.once("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("end", resolve);
  });
  return hash.digest("hex");
}

export interface ManagedWalletArtifactVerification {
  expectedSha256?: string;
  actualSha256?: string;
  valid: boolean;
}

export async function verifyManagedWalletArtifact(
  packageName: string,
  apkPath: string,
): Promise<ManagedWalletArtifactVerification> {
  const expectedSha256 = managedWalletExpectedSha256(packageName);
  if (!expectedSha256) return { valid: false };
  try {
    const actualSha256 = await sha256File(apkPath);
    return { expectedSha256, actualSha256, valid: actualSha256 === expectedSha256 };
  } catch {
    return { expectedSha256, valid: false };
  }
}

export interface StagedManagedWalletArtifact extends ManagedWalletArtifactVerification {
  apkPath?: string;
  dispose(): Promise<void>;
}

export async function stageManagedWalletArtifact(
  packageName: string,
  sourceApkPath: string,
): Promise<StagedManagedWalletArtifact> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-wallet-"));
  const stagedApkPath = path.join(directory, "wallet.apk");
  try {
    await copyFile(sourceApkPath, stagedApkPath);
    await chmod(stagedApkPath, 0o400);
    const verification = await verifyManagedWalletArtifact(packageName, stagedApkPath);
    return {
      ...verification,
      ...(verification.valid ? { apkPath: stagedApkPath } : {}),
      dispose: async () => await rm(directory, { recursive: true, force: true }),
    };
  } catch {
    await rm(directory, { recursive: true, force: true });
    return {
      valid: false,
      dispose: async () => undefined,
    };
  }
}
