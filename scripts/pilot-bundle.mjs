import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectPayloadEntries,
  copyRegularBundleInput,
  createPublisherManifest,
  parseBundleArguments,
  renderSha256Sums,
  resolveNewOutputDirectory,
} from "./pilot-bundle-lib.mjs";
import { verifyPublisherBundle } from "./verify-pilot-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const COPY_MAP = [
  ["docs/publisher-bundle-readme.md", "README.md"],
  ["docs/publisher-pilot-quickstart.md", "docs/publisher-pilot-quickstart.md"],
  ["docs/supported-environment.md", "docs/supported-environment.md"],
  ["docs/flows/mwa-authorize.md", "docs/flows/mwa-authorize.md"],
  ["docs/flows/mwa-reject.md", "docs/flows/mwa-reject.md"],
  ["docs/flows/mwa-sign-message.md", "docs/flows/mwa-sign-message.md"],
  ["docs/flows/mwa-siws.md", "docs/flows/mwa-siws.md"],
  ["schemas/launchrig-publisher-bundle.schema.json", "schemas/launchrig-publisher-bundle.schema.json"],
  ["templates/defect-evidence.md", "templates/defect-evidence.md"],
  ["templates/pilot-consent.md", "templates/pilot-consent.md"],
  ["templates/pilot-notes.md", "templates/pilot-notes.md"],
  ["templates/publisher-intake.md", "templates/publisher-intake.md"],
  ["templates/sharing-review.md", "templates/sharing-review.md"],
];

function helpText() {
  return [
    "Build the LaunchRig publisher release-candidate bundle.",
    "",
    "Usage:",
    "  pnpm run pilot:bundle -- --output /absolute/path/to/new-bundle-directory",
    "",
    "The output directory must not already exist, and its direct parent must be a real directory.",
    "The source worktree must be clean. The command packs LaunchRig, performs a clean offline",
    "consumer install rehearsal, writes a checksum manifest, and verifies the final bundle.",
  ].join("\n");
}

async function run(command, args, options = {}) {
  const acceptedExitCodes = options.acceptedExitCodes ?? [0];
  const timeoutMs = options.timeoutMs ?? 180_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const capture = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
      if (timedOut) {
        reject(new Error(command + " exceeded its execution timeout."));
      } else if (outputLimitExceeded) {
        reject(new Error(command + " exceeded the bounded output limit."));
      } else if (code !== null && acceptedExitCodes.includes(code)) {
        resolve(result);
      } else {
        reject(new Error(result.stderr || result.stdout || command + " exited with code " + code));
      }
    });
  });
}

async function assertCleanSource() {
  const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.stdout) throw new Error("Refusing to build a publisher bundle from a dirty Git worktree.");
  const commit = (await run("git", ["rev-parse", "HEAD"])).stdout;
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Could not resolve a full source commit.");
  return commit;
}

async function copyBundleMaterials(stagingDirectory) {
  for (const [source, destination] of COPY_MAP) {
    await copyRegularBundleInput(path.join(root, ...source.split("/")), path.join(stagingDirectory, ...destination.split("/")));
  }
}

async function assertInstalledFile(installDirectory, relativePath) {
  const target = path.join(installDirectory, "node_modules", "launchrig", ...relativePath.split("/"));
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Clean consumer install is missing " + relativePath + ".");
  }
}

async function rehearseCleanConsumer(archivePath, launchRigVersion) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrig-publisher-rehearsal-"));
  const installDirectory = path.join(temporaryDirectory, "consumer");
  try {
    const storePath = path.join(temporaryDirectory, "empty-store");
    await mkdir(installDirectory, { recursive: true, mode: 0o700 });
    await mkdir(storePath, { recursive: true, mode: 0o700 });
    const rehearsalEnvironment = { ...process.env };
    for (const key of [
      "ANDROID_SERIAL",
      "LAUNCHRIG_ADB_PATH",
      "LAUNCHRIG_MAESTRO_PATH",
      "NODE_OPTIONS",
      "NODE_PATH",
    ]) {
      delete rehearsalEnvironment[key];
    }
    await run(pnpm, ["add", "--dir", installDirectory, "--offline", "--store-dir", storePath, archivePath], {
      env: rehearsalEnvironment,
    });

    const installedPackagePath = path.join(installDirectory, "node_modules", "launchrig", "package.json");
    const installedPackage = JSON.parse(await readFile(installedPackagePath, "utf8"));
    if (installedPackage.name !== "launchrig" || installedPackage.version !== launchRigVersion) {
      throw new Error("Clean consumer install does not match the packed LaunchRig version.");
    }
    if (installedPackage.private !== true) throw new Error("Packed LaunchRig package must remain private.");
    for (const relativePath of [
      "dist/src/cli.js",
      "dist/src/pilot/binding.js",
      "dist/src/pilot/session-scope.js",
      "docs/cohort-audit.md",
      "docs/cohort-verification.md",
      "docs/config-v1-compatibility.md",
      "docs/github-action.md",
      "docs/phase-3-foundation.md",
      "docs/publisher-pilot-quickstart.md",
      "docs/supported-environment.md",
      "docs/flows/mwa-authorize.md",
      "docs/flows/mwa-reject.md",
      "docs/flows/mwa-sign-message.md",
      "docs/flows/mwa-siws.md",
      "schemas/launchrig-publisher-bundle.schema.json",
      "schemas/launchrig-cohort-verification.schema.json",
      "schemas/launchrig-core-rule-catalog.schema.json",
      "schemas/fixtures/launchrig-config-v1.conformance.json",
      "schemas/launchrig-private-cohort-audit.schema.json",
      "schemas/launchrig-private-cohort-register.schema.json",
      "schemas/launchrig-pilot-evidence-binding-receipt.schema.json",
      "schemas/launchrig-pilot-session-scope-receipt.schema.json",
      "schemas/launchrig-pilot-session-scope.schema.json",
      "templates/publisher-intake.md",
      "templates/sharing-review.md",
      "action.yml",
      "action/run-validation.mjs",
      "examples/github-actions/launchrig-validation.yml",
    ]) {
      await assertInstalledFile(installDirectory, relativePath);
    }

    const executable = path.join(
      installDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "launchrig.cmd" : "launchrig",
    );
    const version = await run(executable, ["--version"], { cwd: installDirectory, env: rehearsalEnvironment });
    if (version.stdout !== launchRigVersion) throw new Error("Installed LaunchRig binary reported the wrong version.");
    const help = await run(executable, ["--help"], { cwd: installDirectory, env: rehearsalEnvironment });
    for (const command of [
      "launchrig rules [--json]",
      "launchrig pilot lint",
      "launchrig pilot check --pilot ID --scope FILE",
      "launchrig pilot run --pilot ID --scope FILE",
      "launchrig pilot verify FILE",
      "launchrig pilot binding FILE",
      "launchrig pilot scope FILE",
      "launchrig cohort verify FILE...",
      "launchrig cohort audit REGISTER [EVIDENCE...]",
    ]) {
      if (!help.stdout.includes(command)) throw new Error("Installed LaunchRig help is missing " + command + ".");
    }
    const catalog = JSON.parse(
      (await run(executable, ["rules", "--json"], { cwd: installDirectory, env: rehearsalEnvironment })).stdout,
    );
    if (
      catalog.kind !== "launchrig-core-rule-catalog" ||
      catalog.status !== "pre-award-foundation" ||
      catalog.ruleCount !== 25 ||
      catalog.rules?.length !== 25 ||
      catalog.grantMilestoneComplete !== false
    ) {
      throw new Error("Installed LaunchRig rule catalog does not preserve its pre-award contract.");
    }

    await run(executable, ["pilot", "start", "--pilot", "bundle-rehearsal", "--config", "launchrig.yml"], {
      cwd: installDirectory,
      env: rehearsalEnvironment,
    });
    await run(executable, ["init", "--name", "Bundle Rehearsal App", "--package", "com.example.bundlerehearsal"], {
      cwd: installDirectory,
      env: rehearsalEnvironment,
    });
    const validation = await run(executable, ["validate", "--config", "launchrig.yml"], {
      cwd: installDirectory,
      env: rehearsalEnvironment,
    });
    if (!validation.stdout.includes("Configuration valid")) {
      throw new Error("Clean consumer starter configuration did not validate.");
    }
    const preflight = await run(
      executable,
      ["pilot", "check", "--pilot", "bundle-rehearsal", "--config", "launchrig.yml", "--json"],
      { cwd: installDirectory, env: rehearsalEnvironment, acceptedExitCodes: [2] },
    );
    const preflightOutput = preflight.stdout + "\n" + preflight.stderr;
    if (!preflightOutput.includes("pilot check requires --scope FILE")) {
      throw new Error("Clean consumer preflight did not require an approved private scope.");
    }
    const policyLint = await run(
      executable,
      ["pilot", "lint", "--config", "launchrig.yml", "--json"],
      { cwd: installDirectory, env: rehearsalEnvironment, acceptedExitCodes: [2] },
    );
    const policyLintOutput = policyLint.stdout + "\n" + policyLint.stderr;
    if (
      !policyLintOutput.includes('"kind": "launchrig-pilot-policy-lint"') ||
      !policyLintOutput.includes('"staticPolicyValid": false') ||
      !policyLintOutput.includes("Required MWA coverage is missing") ||
      policyLintOutput.includes("Android Device Ready") ||
      policyLintOutput.includes("Android/MWA Ready")
    ) {
      throw new Error("Clean consumer pilot lint did not safely refuse the unpromoted starter flows.");
    }

    const scopePath = path.join(installDirectory, "private-session-scope.json");
    const scopeInput = {
      schemaVersion: 1,
      kind: "launchrig-pilot-session-scope",
      profile: "external-mwa-pilot-scope-v1",
      scopeRef: "urn:launchrig:scope:123e4567-e89b-42d3-a456-426614174000",
      operatorRef: "urn:launchrig:operator:223e4567-e89b-42d3-a456-426614174000",
      pilotRef: "urn:launchrig:pilot:323e4567-e89b-42d3-a456-426614174000",
      deviceRef: "urn:launchrig:device:423e4567-e89b-42d3-a456-426614174000",
      bundle: {
        bundleId: "sha256:" + "a".repeat(64),
        manifestSha256: "b".repeat(64),
        sha256SumsSha256: "c".repeat(64),
        packageSha256: "d".repeat(64),
      },
      inputs: {
        configSha256: "e".repeat(64),
        appBuildSha256: "f".repeat(64),
        walletArtifactSha256: "0".repeat(64),
        flows: [
          { kind: "mwa-authorize", scenarioId: "authorize", fileSha256: "1".repeat(64) },
          { kind: "mwa-siws", scenarioId: "siws", fileSha256: "2".repeat(64) },
          { kind: "mwa-sign-message", scenarioId: "sign-message", fileSha256: "3".repeat(64) },
          { kind: "mwa-reject", scenarioId: "reject", fileSha256: "4".repeat(64) },
        ],
      },
      policy: {
        network: "devnet",
        walletMode: "mock-mwa",
        physicalAndroidRequired: true,
        attendedExecutionRequired: true,
        manualWalletActionsRequired: true,
        valuableAssetsAllowed: false,
        capture: { screenshots: "failure", includeLogcat: false, logcatLines: 200 },
        retention: { maxRuns: 5, expiresOn: "2030-12-31", deletionMethod: "standard-delete" },
        sharing: {
          publicEvidenceJson: true,
          sanitizedReports: false,
          publisherName: false,
          publisherLogo: false,
          approvedQuote: false,
          confirmedDefectRecord: false,
        },
      },
    };
    const scopeBytes = Buffer.from(JSON.stringify(scopeInput, null, 2) + "\n", "utf8");
    await writeFile(scopePath, scopeBytes, { flag: "wx", mode: 0o600 });
    await chmod(scopePath, 0o600);
    const scopeReceipt = JSON.parse(
      (await run(executable, ["pilot", "scope", scopePath, "--json"], {
        cwd: installDirectory,
        env: rehearsalEnvironment,
      })).stdout,
    );
    if (
      scopeReceipt.kind !== "launchrig-pilot-session-scope-receipt" ||
      scopeReceipt.binding?.bundleId !== scopeInput.bundle.bundleId ||
      scopeReceipt.binding?.packageSha256 !== scopeInput.bundle.packageSha256 ||
      scopeReceipt.bundleVerification?.manifestSha256 !== scopeInput.bundle.manifestSha256 ||
      scopeReceipt.bundleVerification?.sha256SumsSha256 !== scopeInput.bundle.sha256SumsSha256 ||
      scopeReceipt.scopeFileSha256 !== createHash("sha256").update(scopeBytes).digest("hex") ||
      scopeReceipt.policyValid !== true ||
      scopeReceipt.claimStatus !== "operator-prepared-unattested" ||
      scopeReceipt.externalGrantGate !== "not-established" ||
      scopeReceipt.grantReady !== false ||
      JSON.stringify(scopeReceipt).includes(scopePath) ||
      JSON.stringify(scopeReceipt).includes("urn:launchrig:")
    ) {
      throw new Error("Clean consumer session scope receipt did not preserve its private claim-limited contract.");
    }
    const scopedPreflight = await run(
      executable,
      [
        "pilot",
        "check",
        "--pilot",
        "bundle-rehearsal",
        "--scope",
        scopePath,
        "--config",
        "launchrig.yml",
        "--json",
      ],
      { cwd: installDirectory, env: rehearsalEnvironment, acceptedExitCodes: [2] },
    );
    const scopedPreflightOutput = scopedPreflight.stdout + "\n" + scopedPreflight.stderr;
    if (
      !scopedPreflightOutput.includes("Required MWA coverage is missing") ||
      !scopedPreflightOutput.includes("Configuration bytes do not match the approved scope") ||
      !scopedPreflightOutput.includes('"status": "skip"')
    ) {
      throw new Error("Clean consumer scoped preflight did not refuse mismatched inputs before device checks.");
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function buildBundle(output) {
  const sourceCommit = await assertCleanSource();
  const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (
    packageMetadata.name !== "launchrig" ||
    packageMetadata.private !== true ||
    !/^\d+\.\d+\.\d+$/.test(packageMetadata.version)
  ) {
    throw new Error("package.json does not satisfy the private LaunchRig release contract.");
  }
  const versionSource = await readFile(path.join(root, "src", "version.ts"), "utf8");
  const versionMatch = versionSource.match(/LAUNCHRIG_VERSION\s*=\s*"([^"]+)"/);
  if (versionMatch?.[1] !== packageMetadata.version) {
    throw new Error("package.json and src/version.ts must declare the same LaunchRig version.");
  }
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageMetadata.packageManager)) {
    throw new Error("package.json must declare an exact pnpm package manager version.");
  }
  const sourceEnvironment = { ...process.env };
  for (const key of ["ANDROID_SERIAL", "LAUNCHRIG_ADB_PATH", "LAUNCHRIG_MAESTRO_PATH", "NODE_OPTIONS", "NODE_PATH"]) {
    delete sourceEnvironment[key];
  }
  const expectedPnpmVersion = packageMetadata.packageManager.slice("pnpm@".length);
  const actualPnpmVersion = (await run(pnpm, ["--version"], { env: sourceEnvironment })).stdout;
  if (actualPnpmVersion !== expectedPnpmVersion) {
    throw new Error(
      "Release bundling requires pnpm " + expectedPnpmVersion + "; received " + (actualPnpmVersion || "no version") + ".",
    );
  }
  await run(
    pnpm,
    ["install", "--frozen-lockfile", "--offline", "--force", "--ignore-scripts", "--verify-store-integrity"],
    { env: sourceEnvironment },
  );
  const restoredSourceCommit = await assertCleanSource();
  if (restoredSourceCommit !== sourceCommit) throw new Error("Dependency restoration changed the release source.");
  const lockfileSha256 = createHash("sha256")
    .update(await readFile(path.join(root, "pnpm-lock.yaml")))
    .digest("hex");
  const destination = await resolveNewOutputDirectory(output);
  const stagingDirectory = await mkdtemp(path.join(destination.parentDirectory, ".launchrig-bundle-staging-"));
  let outputCreated = false;
  try {
    await run(pnpm, ["run", "check"], { env: sourceEnvironment });
    await run(pnpm, ["test"], { env: sourceEnvironment });
    await run(pnpm, ["run", "package:smoke"], { env: sourceEnvironment });
    const verifiedSourceCommit = await assertCleanSource();
    if (verifiedSourceCommit !== sourceCommit) throw new Error("Source commit changed during source verification.");

    await run(pnpm, ["pack", "--pack-destination", stagingDirectory], { env: sourceEnvironment });
    const archives = (await readdir(stagingDirectory)).filter((entry) => entry.endsWith(".tgz"));
    const expectedArchiveName = "launchrig-" + packageMetadata.version + ".tgz";
    if (archives.length !== 1 || archives[0] !== expectedArchiveName) {
      throw new Error("Expected exactly " + expectedArchiveName + " from pnpm pack.");
    }
    const archivePath = path.join(stagingDirectory, expectedArchiveName);

    await copyBundleMaterials(stagingDirectory);
    const packageBeforeRehearsal = (await collectPayloadEntries(stagingDirectory)).find(
      (entry) => entry.path === expectedArchiveName,
    );
    if (!packageBeforeRehearsal) throw new Error("Packed archive is missing before the consumer rehearsal.");
    await rehearseCleanConsumer(archivePath, packageMetadata.version);
    const finalSourceCommit = await assertCleanSource();
    if (finalSourceCommit !== sourceCommit) throw new Error("Source commit changed during bundle assembly.");

    const files = await collectPayloadEntries(stagingDirectory);
    const packageAfterRehearsal = files.find((entry) => entry.path === expectedArchiveName);
    if (
      !packageAfterRehearsal ||
      packageAfterRehearsal.sizeBytes !== packageBeforeRehearsal.sizeBytes ||
      packageAfterRehearsal.sha256 !== packageBeforeRehearsal.sha256
    ) {
      throw new Error("Packed archive changed during the clean consumer rehearsal.");
    }
    const manifest = createPublisherManifest({
      launchRigVersion: packageMetadata.version,
      gitCommit: sourceCommit,
      lockfileSha256,
      nodeEngine: packageMetadata.engines.node,
      packageManager: packageMetadata.packageManager,
      packagePath: expectedArchiveName,
      files,
    });
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
    const sumsBytes = Buffer.from(renderSha256Sums(files), "utf8");
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    const sumsSha256 = createHash("sha256").update(sumsBytes).digest("hex");
    await writeFile(path.join(stagingDirectory, "manifest.json"), manifestBytes, {
      flag: "wx",
      mode: 0o644,
    });
    await writeFile(path.join(stagingDirectory, "SHA256SUMS"), sumsBytes, {
      flag: "wx",
      mode: 0o644,
    });
    await verifyPublisherBundle(stagingDirectory);

    await mkdir(destination.outputDirectory, { mode: 0o700 });
    outputCreated = true;
    for (const file of [...files.map((entry) => entry.path), "SHA256SUMS"].sort()) {
      await copyRegularBundleInput(
        path.join(stagingDirectory, ...file.split("/")),
        path.join(destination.outputDirectory, ...file.split("/")),
      );
    }
    await copyRegularBundleInput(
      path.join(stagingDirectory, "manifest.json"),
      path.join(destination.outputDirectory, "manifest.json"),
    );
    await verifyPublisherBundle(destination.outputDirectory);
    await chmod(destination.outputDirectory, 0o755);
    await rm(stagingDirectory, { recursive: true, force: true });

    console.log("LaunchRig publisher bundle created and verified.");
    console.log("output: " + destination.outputDirectory);
    console.log("bundle id: " + manifest.bundleId);
    console.log("manifest sha256: " + manifestSha256);
    console.log("sha256sums sha256: " + sumsSha256);
    console.log("package sha256: " + manifest.package.sha256);
    console.log("consumer rehearsal: passed");
    console.log("device or wallet tested by this rehearsal: no");
    console.log("grant ready: no");
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    if (outputCreated) await rm(destination.outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

try {
  const argumentsResult = parseBundleArguments(process.argv.slice(2));
  if (argumentsResult.help) console.log(helpText());
  else await buildBundle(argumentsResult.output);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
