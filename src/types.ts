export type CheckStatus = "pass" | "fail" | "warn" | "skip";
export type SolanaTestNetwork = "devnet" | "testnet";

export interface ProjectConfig {
  name: string;
  packageName: string;
  apk?: string;
  install: boolean;
  installPolicy: "always" | "if-missing";
}

export interface ScenarioConfig {
  id: string;
  kind:
    | "mwa-authorize"
    | "mwa-siws"
    | "mwa-sign-message"
    | "mwa-reject"
    | "mwa-stale-authorization"
    | "mwa-process-death"
    | "custom";
  name: string;
  flow: string;
  required: boolean;
  timeoutMs: number;
}

export interface LaunchRigConfig {
  version: 1;
  project: ProjectConfig;
  target: { network: SolanaTestNetwork };
  device: {
    requirePhysical: boolean;
    minimumApiLevel: number;
  };
  wallet: {
    mode: "mock-mwa" | "reference-fakewallet" | "real";
    packageName?: string;
    apk?: string;
    install: boolean;
    installPolicy: "always" | "if-missing";
  };
  scenarios: ScenarioConfig[];
  artifacts: {
    directory: string;
    screenshots: "failure" | "always" | "never";
    retention: number;
  };
  privacy: {
    includeLogcat: boolean;
    logcatLines: number;
    redactPatterns: string[];
  };
  tooling: {
    adb?: string;
    maestro?: string;
  };
}

export interface ResolvedLaunchRigConfig extends LaunchRigConfig {
  configPath: string;
  configDirectory: string;
  resolvedApk?: string;
  resolvedWalletApk?: string;
  resolvedArtifactDirectory: string;
  scenarios: Array<ScenarioConfig & { resolvedFlow: string }>;
}

export interface AndroidDevice {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
  usb?: string;
  isEmulator: boolean;
}

export interface DeviceSnapshot {
  serial: string;
  manufacturer: string;
  model: string;
  androidVersion: string;
  apiLevel: number;
  abi: string;
  securityPatch: string;
  batteryLevel?: number;
  availableDataKb?: number;
  isEmulator: boolean;
}

export interface PackageSnapshot {
  packageName: string;
  versionName?: string;
  versionCode?: string;
}

export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  required: boolean;
  durationMs: number;
  summary: string;
  details?: string;
  reproduction?: string[];
  artifacts?: string[];
}

export interface LaunchRigReport {
  schemaVersion: 1;
  launchRigVersion: string;
  runId: string;
  project: string;
  packageName: string;
  network: SolanaTestNetwork;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outcome: "passed" | "failed" | "setup-error";
  readiness: "Android Device Ready" | "Android/MWA Ready" | "Not Ready";
  app: PackageSnapshot;
  wallet?: PackageSnapshot;
  device?: Omit<DeviceSnapshot, "serial"> & { serial: string };
  checks: CheckResult[];
}
