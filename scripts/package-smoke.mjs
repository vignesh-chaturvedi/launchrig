import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrig-package-smoke-"));
const packageDirectory = path.join(temporaryDirectory, "package");
const installDirectory = path.join(temporaryDirectory, "install");
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
  for (const document of ["docs/phase-1.md", "docs/phase-2.md", "docs/physical-device.md"]) {
    if (!installedFiles.includes(document)) throw new Error("Packed documentation is missing " + document + ".");
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
