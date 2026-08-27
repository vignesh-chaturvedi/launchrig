import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import type { PilotRunEvidenceV1, PilotStateCoreV1, PilotStateV1 } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const PILOT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class PilotError extends Error {
  constructor(
    message: string,
    readonly exitCode: 2 | 3 = 2,
  ) {
    super(message);
    this.name = "PilotError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unsupported.length > 0) throw new PilotError(label + " contains unsupported fields");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new PilotError(label + " must be a non-empty string");
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new PilotError(label + " must be a boolean");
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PilotError(label + " must be a non-negative safe integer");
  }
  return value as number;
}

function strictTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(timestamp).toISOString() !== timestamp
  ) {
    throw new PilotError(label + " must be a strict UTC timestamp");
  }
  return timestamp;
}

function strictHash(value: unknown, label: string): string {
  const digest = requiredString(value, label);
  if (!SHA256.test(digest)) throw new PilotError(label + " must be a lowercase SHA-256 digest");
  return digest;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PilotError("Pilot state contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map((entry) => canonicalJson(entry)).join(",") + "]";
  if (!isRecord(value)) throw new PilotError("Pilot state contains an unsupported value");
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
      .join(",") +
    "}"
  );
}

export function sha256Value(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function parseFlowHashes(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new PilotError("Pilot run flowSha256 must be an object");
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 50) throw new PilotError("Pilot run flowSha256 has an invalid size");
  const result: Record<string, string> = {};
  for (const [scenarioId, digest] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(scenarioId)) throw new PilotError("Pilot run contains an invalid scenario ID");
    result[scenarioId] = strictHash(digest, "Pilot run flow hash");
  }
  return result;
}

function parseRun(value: unknown): PilotRunEvidenceV1 {
  if (!isRecord(value)) throw new PilotError("Pilot run must be an object");
  assertKeys(
    value,
    [
      "runId",
      "recordedAt",
      "outcome",
      "readiness",
      "durationMs",
      "reportSha256",
      "failureKind",
      "configSha256",
      "flowSha256",
      "appArtifactSha256",
      "walletArtifactSha256",
      "launchRigVersion",
      "appSnapshotSha256",
      "walletSnapshotSha256",
      "physicalDevice",
      "requiredChecksPassed",
      "qualifying",
    ],
    "Pilot run",
  );
  const outcome = value.outcome;
  if (outcome !== "passed" && outcome !== "failed" && outcome !== "setup-error") {
    throw new PilotError("Pilot run outcome is invalid");
  }
  const readiness = value.readiness;
  if (readiness !== "Android Device Ready" && readiness !== "Android/MWA Ready" && readiness !== "Not Ready") {
    throw new PilotError("Pilot run readiness is invalid");
  }
  const physicalDevice = requiredBoolean(value.physicalDevice, "Pilot run physicalDevice");
  const requiredChecksPassed = requiredBoolean(value.requiredChecksPassed, "Pilot run requiredChecksPassed");
  const qualifying = requiredBoolean(value.qualifying, "Pilot run qualifying");
  if (qualifying !== (outcome === "passed" && physicalDevice && requiredChecksPassed)) {
    throw new PilotError("Pilot run qualifying state is inconsistent");
  }
  const runId = requiredString(value.runId, "Pilot run ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) {
    throw new PilotError("Pilot run ID has an invalid format");
  }
  if (
    (outcome === "passed" && readiness === "Not Ready") ||
    (outcome !== "passed" && readiness !== "Not Ready")
  ) {
    throw new PilotError("Pilot run readiness is inconsistent with its outcome");
  }
  const run: PilotRunEvidenceV1 = {
    runId,
    recordedAt: strictTimestamp(value.recordedAt, "Pilot run recordedAt"),
    outcome,
    readiness,
    durationMs: requiredInteger(value.durationMs, "Pilot run durationMs"),
    configSha256: strictHash(value.configSha256, "Pilot run configSha256"),
    flowSha256: parseFlowHashes(value.flowSha256),
    physicalDevice,
    requiredChecksPassed,
    qualifying,
  };
  if (value.failureKind !== undefined) {
    if (
      value.failureKind !== "runner-error" &&
      value.failureKind !== "input-mutation" &&
      value.failureKind !== "report-invalid"
    ) {
      throw new PilotError("Pilot run failureKind is invalid");
    }
    run.failureKind = value.failureKind;
    if (outcome !== "setup-error" || readiness !== "Not Ready" || physicalDevice || requiredChecksPassed || qualifying) {
      throw new PilotError("Pilot failed-attempt state is inconsistent");
    }
  }
  if (value.reportSha256 !== undefined) {
    run.reportSha256 = strictHash(value.reportSha256, "Pilot run reportSha256");
  } else if (!run.failureKind) {
    throw new PilotError("Pilot run reportSha256 is required for a completed report");
  }
  if (value.appArtifactSha256 !== undefined) {
    run.appArtifactSha256 = strictHash(value.appArtifactSha256, "Pilot run appArtifactSha256");
  }
  if (value.walletArtifactSha256 !== undefined) {
    run.walletArtifactSha256 = strictHash(value.walletArtifactSha256, "Pilot run walletArtifactSha256");
  }
  if (value.launchRigVersion !== undefined) {
    const version = requiredString(value.launchRigVersion, "Pilot run launchRigVersion");
    if (version.length > 64) throw new PilotError("Pilot run launchRigVersion is too long");
    run.launchRigVersion = version;
  }
  if (value.appSnapshotSha256 !== undefined) {
    run.appSnapshotSha256 = strictHash(value.appSnapshotSha256, "Pilot run appSnapshotSha256");
  }
  if (value.walletSnapshotSha256 !== undefined) {
    run.walletSnapshotSha256 = strictHash(value.walletSnapshotSha256, "Pilot run walletSnapshotSha256");
  }
  if (!run.failureKind && (!run.launchRigVersion || !run.appSnapshotSha256)) {
    throw new PilotError("Pilot completed run must bind its tool and installed app snapshot");
  }
  return run;
}

function parseState(value: unknown): PilotStateV1 {
  if (!isRecord(value)) throw new PilotError("Pilot state must be an object");
  assertKeys(value, ["schemaVersion", "pilotId", "evidenceId", "startedAt", "firstPassingRunAt", "runs", "integritySha256"], "Pilot state");
  if (value.schemaVersion !== 1) throw new PilotError("Pilot state schemaVersion must be 1");
  const pilotId = requiredString(value.pilotId, "Pilot ID");
  assertPilotId(pilotId);
  const evidenceId = requiredString(value.evidenceId, "Pilot evidence ID");
  if (!UUID.test(evidenceId)) throw new PilotError("Pilot evidence ID must be a lowercase UUIDv4");
  if (!Array.isArray(value.runs) || value.runs.length > 100) throw new PilotError("Pilot state runs must contain at most 100 entries");
  const runs = value.runs.map(parseRun);
  if (new Set(runs.map((run) => run.runId)).size !== runs.length) throw new PilotError("Pilot state contains duplicate run IDs");
  const startedAt = strictTimestamp(value.startedAt, "Pilot startedAt");
  let previousTimestamp = startedAt;
  for (const run of runs) {
    if (Date.parse(run.recordedAt) < Date.parse(previousTimestamp)) {
      throw new PilotError("Pilot run timestamps must be chronological");
    }
    previousTimestamp = run.recordedAt;
  }
  const core: PilotStateCoreV1 = {
    schemaVersion: 1,
    pilotId,
    evidenceId,
    startedAt,
    runs,
  };
  if (value.firstPassingRunAt !== undefined) {
    core.firstPassingRunAt = strictTimestamp(value.firstPassingRunAt, "Pilot firstPassingRunAt");
  }
  const firstQualifyingRun = runs.find((run) => run.qualifying);
  if (core.firstPassingRunAt !== firstQualifyingRun?.recordedAt) {
    throw new PilotError("Pilot firstPassingRunAt is inconsistent with its runs");
  }
  const integritySha256 = strictHash(value.integritySha256, "Pilot integritySha256");
  if (sha256Value(core) !== integritySha256) throw new PilotError("Pilot state integrity check failed");
  return { ...core, integritySha256 };
}

export function assertPilotId(pilotId: string): void {
  if (!PILOT_ID.test(pilotId)) {
    throw new PilotError("Pilot ID must be a lowercase slug with at most 64 characters");
  }
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

async function resolvePilotDirectory(
  root: string,
  pilotId: string,
  create: boolean,
  restrictPermissions: boolean,
): Promise<string> {
  let current = root;
  for (const segment of [".launchrig", "pilots", pilotId]) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (!create || errorCode(error) !== "ENOENT") {
        throw new PilotError("Pilot state has not been started", 3);
      }
      try {
        await mkdir(current, { mode: 0o700 });
        metadata = await lstat(current);
      } catch {
        throw new PilotError("Pilot state directory cannot be created", 3);
      }
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new PilotError("Pilot state path must use project-owned directories", 3);
    }
    if (restrictPermissions) {
      await chmod(current, 0o700).catch(() => {
        throw new PilotError("Pilot state directory permissions cannot be restricted", 3);
      });
    } else if ((metadata.mode & 0o077) !== 0) {
      throw new PilotError("Pilot state directory permissions are not restricted", 3);
    }
    const resolved = await realpath(current).catch(() => {
      throw new PilotError("Pilot state directory cannot be resolved", 3);
    });
    if (!isContained(root, resolved)) throw new PilotError("Pilot state directory escapes the project", 3);
    current = resolved;
  }
  return current;
}

export async function pilotStatePath(configDirectory: string, pilotId: string, create = false): Promise<string> {
  assertPilotId(pilotId);
  const root = await realpath(configDirectory).catch(() => {
    throw new PilotError("Pilot configuration directory cannot be resolved", 3);
  });
  const resolvedDirectory = await resolvePilotDirectory(root, pilotId, create, true);
  return path.join(resolvedDirectory, "evidence.json");
}

export async function readOnlyPilotStatePath(configDirectory: string, pilotId: string): Promise<string> {
  assertPilotId(pilotId);
  const root = await realpath(configDirectory).catch(() => {
    throw new PilotError("Pilot configuration directory cannot be resolved", 3);
  });
  const resolvedDirectory = await resolvePilotDirectory(root, pilotId, false, false);
  return path.join(resolvedDirectory, "evidence.json");
}

export async function readPilotState(statePath: string): Promise<PilotStateV1> {
  let source: string;
  let handle;
  try {
    handle = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new PilotError("Pilot state must be a regular file");
    if (metadata.size > 1024 * 1024) throw new PilotError("Pilot state exceeds the 1 MiB limit");
    source = await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof PilotError) throw error;
    throw new PilotError("Pilot state cannot be read", 3);
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new PilotError("Pilot state is not strict JSON");
  }
  const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) throw new PilotError("Pilot state is not strict JSON");
  return parseState(value);
}

export async function writePilotState(statePath: string, core: PilotStateCoreV1, replace: boolean): Promise<PilotStateV1> {
  const state: PilotStateV1 = { ...core, integritySha256: sha256Value(core) };
  const validatedState = parseState(state);
  const source = JSON.stringify(validatedState, null, 2) + "\n";
  if (!replace) {
    try {
      await writeFile(statePath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return validatedState;
    } catch (error) {
      if (isRecord(error) && error.code === "EEXIST") {
        throw new PilotError("Pilot state already exists; use --force only to restart it");
      }
      throw new PilotError("Pilot state cannot be written", 3);
    }
  }
  const temporaryPath = statePath + "." + randomUUID() + ".part";
  try {
    await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, statePath);
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    throw new PilotError("Pilot state cannot be replaced", 3);
  }
  return validatedState;
}

export async function withPilotLock<T>(statePath: string, action: () => Promise<T>): Promise<T> {
  const lockPath = statePath + ".lock";
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new PilotError("Pilot state is locked by another run", 3);
    throw new PilotError("Pilot state lock cannot be created", 3);
  }
  try {
    return await action();
  } finally {
    await rmdir(lockPath).catch(() => undefined);
  }
}
