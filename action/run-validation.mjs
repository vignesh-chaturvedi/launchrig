import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESULT_SCHEMA_VERSION = 1;
const RESULT_KIND = "launchrig-validation-action-result";
const MAX_PATH_INPUT_LENGTH = 240;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_ACTION_RESULT_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 128 * 1024;
const MAX_CLI_BYTES = 10 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;

class ActionFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ActionFailure";
    this.code = code;
  }
}

function failure(code, message) {
  return new ActionFailure(code, message);
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function assertContained(root, candidate, label) {
  if (!isContained(root, candidate)) throw failure("unsafe-path", label + " escapes its allowed root.");
}

function parseRelativeInput(value, label, allowDot = false) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_INPUT_LENGTH ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.normalize(value) !== value
  ) {
    throw failure("unsafe-path", label + " must be a normalized relative path.");
  }
  if (allowDot && value === ".") return [];
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw failure("unsafe-path", label + " contains an unsafe path segment.");
  }
  return parts;
}

async function inspectDirectory(root, parts, label, createMissing = false) {
  let current = root;
  for (const part of parts) {
    const candidate = path.join(current, part);
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      if (!createMissing || error?.code !== "ENOENT") {
        throw failure("unsafe-path", label + " is not an existing safe directory.");
      }
      try {
        await mkdir(candidate, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw mkdirError;
      }
      metadata = await lstat(candidate);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw failure("unsafe-path", label + " contains a non-directory or symlink component.");
    }
    const resolved = await realpath(candidate);
    assertContained(root, resolved, label);
    current = resolved;
  }
  return current;
}

async function inspectWorkspace(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !path.isAbsolute(value)
  ) {
    throw failure("unsafe-workspace", "GITHUB_WORKSPACE must be an absolute directory path.");
  }
  const metadata = await lstat(value).catch(() => undefined);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw failure("unsafe-workspace", "GITHUB_WORKSPACE must be an existing non-symlink directory.");
  }
  return await realpath(value);
}

async function inspectConfigFile(workingDirectory, parts) {
  const parent = await inspectDirectory(workingDirectory, parts.slice(0, -1), "config parent");
  const candidate = path.join(parent, parts.at(-1));
  const metadata = await lstat(candidate).catch(() => undefined);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) {
    throw failure("unsafe-config", "Config must be a non-symlink regular file no larger than 1 MiB.");
  }
  const resolved = await realpath(candidate);
  assertContained(workingDirectory, resolved, "config");
  return resolved;
}

async function inspectOutputFile(workingDirectory, parts) {
  const parent = await inspectDirectory(workingDirectory, parts.slice(0, -1), "output parent", true);
  const candidate = path.join(parent, parts.at(-1));
  const metadata = await lstat(candidate).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (metadata && (metadata.isSymbolicLink() || !metadata.isFile())) {
    throw failure("unsafe-output", "Output must be absent or an existing non-symlink LaunchRig result file.");
  }
  if (metadata) {
    let existing;
    try {
      const source = new TextDecoder("utf-8", { fatal: true }).decode(
        await readBoundedRegularFile(
          candidate,
          MAX_ACTION_RESULT_BYTES,
          "unsafe-output",
          "Existing output must be a bounded non-symlink LaunchRig result file.",
        ),
      );
      existing = JSON.parse(source);
    } catch (error) {
      if (error instanceof ActionFailure) throw error;
      throw failure("unsafe-output", "Existing output is not a LaunchRig validation Action result.");
    }
    if (
      !existing ||
      typeof existing !== "object" ||
      Array.isArray(existing) ||
      existing.schemaVersion !== RESULT_SCHEMA_VERSION ||
      existing.kind !== RESULT_KIND
    ) {
      throw failure("unsafe-output", "Existing output is not a LaunchRig validation Action result.");
    }
  }
  assertContained(workingDirectory, candidate, "output");
  return candidate;
}

export async function resolveActionPaths(environment) {
  const workspace = await inspectWorkspace(environment.GITHUB_WORKSPACE);
  const workingParts = parseRelativeInput(
    environment.LAUNCHRIG_ACTION_WORKING_DIRECTORY ?? ".",
    "working-directory",
    true,
  );
  const configParts = parseRelativeInput(environment.LAUNCHRIG_ACTION_CONFIG ?? "launchrig.yml", "config");
  const outputParts = parseRelativeInput(
    environment.LAUNCHRIG_ACTION_OUTPUT ?? ".launchrig/validation.json",
    "output",
  );
  if (
    outputParts.length < 2 ||
    outputParts[0] !== ".launchrig" ||
    !outputParts.at(-1).endsWith(".json")
  ) {
    throw failure("unsafe-output", "Output must be a JSON file beneath the working directory's .launchrig directory.");
  }
  const workingDirectory = await inspectDirectory(workspace, workingParts, "working-directory");
  const configPath = await inspectConfigFile(workingDirectory, configParts);
  const outputPath = await inspectOutputFile(workingDirectory, outputParts);
  if (outputPath === configPath) {
    throw failure("unsafe-output", "Output must not replace the LaunchRig configuration.");
  }
  const configFile = path.relative(workspace, configPath).split(path.sep).join("/");
  const resultFile = path.relative(workspace, outputPath).split(path.sep).join("/");
  return { workspace, workingDirectory, configPath, outputPath, configFile, resultFile };
}

async function readBoundedRegularFile(
  filePath,
  maximumBytes,
  errorCode = "unsafe-launchrig-package",
  errorMessage = "LaunchRig package contains an unsafe or oversized file.",
) {
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw failure(errorCode, errorMessage);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== metadata.size || bytes.length > maximumBytes) {
      throw failure(errorCode, errorMessage);
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function safePackageBin(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 160 ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw failure("unsafe-launchrig-package", "LaunchRig package declares an unsafe CLI path.");
  }
  return value;
}

async function inspectLaunchRigPackage(packagePath) {
  const resolvedPackagePath = await realpath(packagePath);
  const packageSource = new TextDecoder("utf-8", { fatal: true }).decode(
    await readBoundedRegularFile(resolvedPackagePath, MAX_PACKAGE_BYTES),
  );
  let metadata;
  try {
    metadata = JSON.parse(packageSource);
  } catch {
    throw failure("unsafe-launchrig-package", "LaunchRig package metadata is not valid JSON.");
  }
  const binValue = typeof metadata?.bin === "string" ? metadata.bin : metadata?.bin?.launchrig;
  if (
    metadata?.name !== "launchrig" ||
    typeof metadata?.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)
  ) {
    throw failure("unsafe-launchrig-package", "Resolved dependency is not a versioned LaunchRig package.");
  }
  const packageRoot = path.dirname(resolvedPackagePath);
  const cliCandidate = path.join(packageRoot, ...safePackageBin(binValue).split("/"));
  const cliMetadata = await lstat(cliCandidate).catch(() => undefined);
  if (!cliMetadata) {
    throw failure("launchrig-cli-unavailable", "LaunchRig CLI is not built in the Action source.");
  }
  if (
    cliMetadata.isSymbolicLink() ||
    !cliMetadata.isFile() ||
    cliMetadata.size === 0 ||
    cliMetadata.size > MAX_CLI_BYTES
  ) {
    throw failure("unsafe-launchrig-package", "LaunchRig CLI is missing, unsafe, or oversized.");
  }
  const cliPath = await realpath(cliCandidate);
  assertContained(packageRoot, cliPath, "LaunchRig CLI");
  return cliPath;
}

export async function resolveLaunchRigCli(workingDirectory, environment = process.env) {
  const actionPath = environment.GITHUB_ACTION_PATH;
  if (typeof actionPath === "string" && path.isAbsolute(actionPath)) {
    const actionPackagePath = path.join(actionPath, "package.json");
    try {
      return await inspectLaunchRigPackage(actionPackagePath);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "launchrig-cli-unavailable") throw error;
    }
  }
  try {
    const resolver = createRequire(path.join(workingDirectory, "launchrig-action-resolver.cjs"));
    return await inspectLaunchRigPackage(resolver.resolve("launchrig/package.json"));
  } catch (error) {
    if (
      error instanceof ActionFailure &&
      ["unsafe-launchrig-package", "launchrig-cli-unavailable"].includes(error.code)
    ) {
      throw error;
    }
    throw failure(
      "launchrig-not-installed",
      "Install a versioned LaunchRig package in the caller project before using this Action.",
    );
  }
}

export function assertSupportedNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw failure("unsupported-node", "Unable to determine the Node.js version.");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 20 || (major === 20 && minor < 11)) {
    throw failure("unsupported-node", "LaunchRig validation requires Node.js 20.11 or newer.");
  }
}

function reducedChildEnvironment(environment) {
  const childEnvironment = { NO_COLOR: "1" };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) {
    if (typeof environment[key] === "string") childEnvironment[key] = environment[key];
  }
  return childEnvironment;
}

function decodeOutput(chunks) {
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

export async function executeLaunchRig({
  cliPath,
  workingDirectory,
  configPath,
  environment = process.env,
  timeoutMs = COMMAND_TIMEOUT_MS,
  maximumOutputBytes = MAX_COMMAND_OUTPUT_BYTES,
}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "validate", "--config", configPath, "--json"], {
      cwd: workingDirectory,
      env: reducedChildEnvironment(environment),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputLimited = false;
    let spawnError;
    const capture = (target) => (chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > maximumOutputBytes) {
        outputLimited = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", (error) => {
      spawnError = error;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (spawnError) {
        reject(spawnError);
        return;
      }
      try {
        resolve({
          exitCode,
          signal,
          stdout: decodeOutput(stdout),
          stderr: decodeOutput(stderr),
          timedOut,
          outputLimited,
        });
      } catch {
        reject(failure("invalid-command-output", "LaunchRig command output is not valid UTF-8."));
      }
    });
  });
}

function parseValidationOutput(execution, expectedConfigPath) {
  if (execution.timedOut) throw failure("command-timeout", "LaunchRig validation exceeded 60 seconds.");
  if (execution.outputLimited) throw failure("command-output-limit", "LaunchRig validation output exceeded 1 MiB.");
  if (execution.signal) throw failure("command-signal", "LaunchRig validation was terminated by a signal.");
  if (execution.exitCode !== 0 && execution.exitCode !== 2) {
    throw failure("command-exit", "LaunchRig validation returned an unsupported exit code.");
  }
  let value;
  try {
    value = JSON.parse(execution.stdout);
  } catch {
    throw failure("invalid-command-output", "LaunchRig validation did not return structured JSON.");
  }
  const expectedKeys = ["configPath", "issues", "packageName", "project", "scenarios", "valid"];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys) ||
    typeof value.valid !== "boolean" ||
    typeof value.configPath !== "string" ||
    path.resolve(value.configPath) !== expectedConfigPath ||
    typeof value.project !== "string" ||
    value.project.length === 0 ||
    typeof value.packageName !== "string" ||
    value.packageName.length === 0 ||
    !Number.isSafeInteger(value.scenarios) ||
    value.scenarios < 0 ||
    value.scenarios > 50 ||
    !Array.isArray(value.issues) ||
    value.issues.length > 200 ||
    value.issues.some((issue) => typeof issue !== "string" || issue.length === 0 || issue.length > 4000) ||
    (value.valid && value.issues.length !== 0) ||
    (!value.valid && value.issues.length === 0) ||
    (value.valid && execution.exitCode !== 0) ||
    (!value.valid && execution.exitCode !== 2)
  ) {
    throw failure("invalid-command-output", "LaunchRig validation returned a contradictory or malformed result.");
  }
  return value;
}

function createResult(paths, validation, failureCode) {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    kind: RESULT_KIND,
    status: validation?.valid ? "passed" : validation ? "failed" : "error",
    valid: validation?.valid ?? false,
    configFile: paths.configFile,
    resultFile: paths.resultFile,
    scenarioCount: validation?.scenarios ?? null,
    validation: validation
      ? {
          project: validation.project,
          packageName: validation.packageName,
          scenarios: validation.scenarios,
          issues: validation.issues,
        }
      : null,
    failureCode,
  };
}

async function writeAtomicJson(outputPath, value) {
  const temporaryPath = path.join(
    path.dirname(outputPath),
    "." + path.basename(outputPath) + "." + process.pid + "." + randomUUID() + ".tmp",
  );
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, outputPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function appendGithubOutputs(outputFile, result) {
  if (
    typeof outputFile !== "string" ||
    outputFile.length === 0 ||
    outputFile.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(outputFile) ||
    !path.isAbsolute(outputFile)
  ) {
    throw failure("unsafe-github-output", "GITHUB_OUTPUT must be an absolute regular file path.");
  }
  const metadata = await lstat(outputFile).catch(() => undefined);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 1024 * 1024) {
    throw failure("unsafe-github-output", "GITHUB_OUTPUT must be an existing bounded non-symlink file.");
  }
  const scenarioCount = result.scenarioCount === null ? "" : String(result.scenarioCount);
  const source = [
    "valid=" + (result.valid ? "true" : "false"),
    "scenario-count=" + scenarioCount,
    "result-file=" + result.resultFile,
    "",
  ].join("\n");
  let handle;
  try {
    handle = await open(
      outputFile,
      constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
    );
    await handle.writeFile(source, "utf8");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function runValidationAction(environment = process.env, dependencies = {}) {
  assertSupportedNodeVersion(dependencies.nodeVersion ?? process.versions.node);
  const paths = await resolveActionPaths(environment);
  let validation = null;
  let failureCode = null;
  try {
    const cliPath = await (dependencies.resolveLaunchRigCli ?? resolveLaunchRigCli)(
      paths.workingDirectory,
      environment,
    );
    const execution = await (dependencies.executeLaunchRig ?? executeLaunchRig)({
      cliPath,
      workingDirectory: paths.workingDirectory,
      configPath: paths.configPath,
      environment,
    });
    validation = parseValidationOutput(execution, paths.configPath);
    if (!validation.valid) failureCode = "configuration-invalid";
  } catch (error) {
    failureCode = error instanceof ActionFailure ? error.code : "validation-command-error";
  }
  const result = createResult(paths, validation, failureCode);
  await writeAtomicJson(paths.outputPath, result);
  await appendGithubOutputs(environment.GITHUB_OUTPUT, result);
  return { exitCode: result.valid ? 0 : 1, result };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const outcome = await runValidationAction();
    console.log(
      outcome.result.valid
        ? "LaunchRig configuration validation passed."
        : "LaunchRig configuration validation failed. Inspect the normalized result file.",
    );
    process.exitCode = outcome.exitCode;
  } catch {
    console.error("LaunchRig validation Action could not complete safely.");
    process.exitCode = 1;
  }
}
