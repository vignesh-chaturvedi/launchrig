import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrig-package-smoke-"));
const packageDirectory = path.join(temporaryDirectory, "package");
const installDirectory = path.join(temporaryDirectory, "install");
const publisherDirectory = path.join(temporaryDirectory, "publisher");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
      if (code === 0) resolve(result);
      else reject(new Error(result.stderr || result.stdout || command + " exited with code " + code));
    });
  });
}

async function collectFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path.join(directory, entry.name), relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
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

function sha256Value(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

try {
  const storePath = (await run(pnpm, ["store", "path", "--silent"])).stdout;
  if (!storePath) throw new Error("Could not resolve the pnpm content-addressed store.");
  await mkdir(packageDirectory, { recursive: true });
  await run(pnpm, ["pack", "--pack-destination", packageDirectory]);
  const archives = (await readdir(packageDirectory)).filter((entry) => entry.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error("Expected exactly one LaunchRig package archive.");
  const archive = path.join(packageDirectory, archives[0]);

  await mkdir(installDirectory, { recursive: true });
  await run(pnpm, ["add", "--dir", installDirectory, "--offline", "--store-dir", storePath, archive]);
  const installedDirectory = path.join(installDirectory, "node_modules", "launchrig");
  const installedPackage = JSON.parse(await readFile(path.join(installedDirectory, "package.json"), "utf8"));
  const installedFiles = await collectFiles(installedDirectory);

  if (!installedFiles.includes("dist/src/cli.js")) throw new Error("Packed CLI entrypoint is missing.");
  if (!installedFiles.includes("schemas/launchrig.schema.json")) throw new Error("Packed config schema is missing.");
  if (!installedFiles.includes("schemas/launchrig-pilot-evidence.schema.json")) {
    throw new Error("Packed pilot evidence schema is missing.");
  }
  for (const document of [
    "docs/phase-1.md",
    "docs/phase-2.md",
    "docs/physical-device.md",
    "docs/publisher-pilot-quickstart.md",
  ]) {
    if (!installedFiles.includes(document)) throw new Error("Packed documentation is missing " + document + ".");
  }
  for (const template of ["templates/pilot-consent.md", "templates/pilot-notes.md", "templates/defect-evidence.md"]) {
    if (!installedFiles.includes(template)) throw new Error("Packed template is missing " + template + ".");
  }
  if (installedFiles.some((file) => file.startsWith("dist/test/"))) {
    throw new Error("Packed archive must not contain the test suite.");
  }
  if (!installedFiles.includes("dist/node_modules/yaml/package.json")) {
    throw new Error("Packed archive is missing the pinned YAML runtime.");
  }
  if (!installedFiles.includes("dist/node_modules/yaml/LICENSE")) {
    throw new Error("Packed archive is missing the YAML runtime license.");
  }
  if (installedPackage.private !== true) throw new Error("Packed package must remain private.");

  const executable = path.join(
    installDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "launchrig.cmd" : "launchrig",
  );
  const version = await run(executable, ["--version"], { cwd: installDirectory });
  if (version.stdout !== installedPackage.version) {
    throw new Error(
      "Installed CLI version " + JSON.stringify(version.stdout) +
        " does not match package metadata " + JSON.stringify(installedPackage.version) + ".",
    );
  }
  const help = await run(executable, ["--help"], { cwd: installDirectory });
  if (!help.stdout.includes("launchrig pilot verify FILE")) {
    throw new Error("Installed CLI help is missing the public evidence verifier.");
  }
  if (!help.stdout.includes("launchrig pilot check --pilot ID")) {
    throw new Error("Installed CLI help is missing the publisher pilot preflight.");
  }

  await mkdir(publisherDirectory, { recursive: true });
  await run(executable, ["pilot", "start", "--pilot", "package-smoke", "--config", "launchrig.yml"], {
    cwd: publisherDirectory,
  });
  await run(executable, ["init", "--name", "Package Smoke App", "--package", "com.example.packagesmoke"], {
    cwd: publisherDirectory,
  });
  const validation = await run(executable, ["validate", "--config", "launchrig.yml"], {
    cwd: publisherDirectory,
  });
  if (!validation.stdout.includes("Configuration valid")) {
    throw new Error("Installed publisher starter configuration did not validate.");
  }
  let preflightFailure;
  try {
    await run(
      executable,
      ["pilot", "check", "--pilot", "package-smoke", "--config", "launchrig.yml", "--json"],
      { cwd: publisherDirectory },
    );
  } catch (error) {
    preflightFailure = error;
  }
  if (
    !(preflightFailure instanceof Error) ||
    !preflightFailure.message.includes("Required MWA coverage is missing") ||
    !preflightFailure.message.includes('"status": "skip"')
  ) {
    throw new Error("Installed pilot preflight did not reject the incomplete starter without device access.");
  }
  const ignoreSource = await readFile(path.join(publisherDirectory, ".gitignore"), "utf8");
  if (!ignoreSource.split(/\r?\n/).includes(".launchrig/")) {
    throw new Error("Installed init did not ignore private LaunchRig state.");
  }
  for (const flow of ["mwa-authorize", "mwa-siws", "mwa-sign-message", "mwa-reject"]) {
    await readFile(path.join(publisherDirectory, "launchrig-flows", flow + ".example.yaml"), "utf8");
  }

  const evidenceCore = {
    schemaVersion: 1,
    kind: "launchrig-pilot-evidence",
    evidenceId: "123e4567-e89b-42d3-a456-426614174000",
    claimStatus: "self-recorded-unattested",
    metrics: {
      runAttempts: 0,
      qualifyingRuns: 0,
      passRate: 0,
      consecutivePasses: 0,
      medianRunDurationMs: null,
      setupDurationMs: null,
      executionFingerprintSha256: null,
      setupTargetMet: false,
      runtimeTargetMet: false,
      repeatabilityTargetMet: false,
    },
    runs: [],
    claims: {
      externalPublisher: "not-established",
      seekerHardware: "not-established",
      productionWallet: "not-established",
      seedVault: "not-established",
      confirmedDefect: "not-established",
    },
  };
  const evidencePath = path.join(publisherDirectory, "pilot-evidence.json");
  await writeFile(
    evidencePath,
    JSON.stringify({ ...evidenceCore, evidenceSha256: sha256Value(evidenceCore) }, null, 2) + "\n",
    "utf8",
  );
  const verification = await run(executable, ["pilot", "verify", evidencePath], { cwd: publisherDirectory });
  if (
    !verification.stdout.includes("Public pilot evidence: internally consistent") ||
    !verification.stdout.includes("grant ready: no")
  ) {
    throw new Error("Installed public evidence verifier did not preserve claim limitations.");
  }

  let matrixFailure;
  try {
    await run(executable, ["matrix"], { cwd: installDirectory });
  } catch (error) {
    matrixFailure = error;
  }
  if (!(matrixFailure instanceof Error) || !matrixFailure.message.includes("source checkout")) {
    throw new Error("Installed matrix command must refuse execution outside a source checkout.");
  }

  console.log("LaunchRig package smoke test passed for " + installedPackage.version + ".");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
