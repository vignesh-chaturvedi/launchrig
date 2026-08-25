import { randomBytes } from "node:crypto";
import type {
  CheckResult,
  DeviceSnapshot,
  LaunchRigReport,
  PackageSnapshot,
  SolanaTestNetwork,
} from "../types.js";
import { publicDeviceSnapshot } from "../device/privacy.js";
import { LAUNCHRIG_VERSION } from "../version.js";

export function createRunId(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return timestamp + "-" + randomBytes(3).toString("hex");
}

export function createReport(input: {
  runId: string;
  project: string;
  packageName: string;
  network: SolanaTestNetwork;
  startedAt: Date;
  completedAt: Date;
  checks: CheckResult[];
  device?: DeviceSnapshot;
  app?: PackageSnapshot;
  wallet?: PackageSnapshot;
  setupError?: boolean;
  mwaCoverageComplete?: boolean;
}): LaunchRigReport {
  const failed = input.checks.some((check) => check.required && check.status === "fail");
  const outcome = input.setupError ? "setup-error" : failed ? "failed" : "passed";
  const readiness =
    outcome !== "passed"
      ? "Not Ready"
      : input.mwaCoverageComplete
        ? "Android/MWA Ready"
        : "Android Device Ready";
  return {
    schemaVersion: 1,
    launchRigVersion: LAUNCHRIG_VERSION,
    runId: input.runId,
    project: input.project,
    packageName: input.packageName,
    network: input.network,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    durationMs: input.completedAt.getTime() - input.startedAt.getTime(),
    outcome,
    readiness,
    app: input.app ?? { packageName: input.packageName },
    ...(input.wallet ? { wallet: input.wallet } : {}),
    checks: input.checks,
    ...(input.device ? { device: publicDeviceSnapshot(input.device) } : {}),
  };
}
