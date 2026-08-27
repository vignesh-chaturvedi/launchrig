import type { RunOptions, RunOutput } from "../runner/orchestrator.js";

export interface PilotRunEvidenceV1 {
  runId: string;
  recordedAt: string;
  outcome: "passed" | "failed" | "setup-error";
  readiness: "Android Device Ready" | "Android/MWA Ready" | "Not Ready";
  durationMs: number;
  reportSha256?: string;
  failureKind?: "runner-error" | "input-mutation" | "report-invalid";
  configSha256: string;
  flowSha256: Record<string, string>;
  appArtifactSha256?: string;
  walletArtifactSha256?: string;
  launchRigVersion?: string;
  appSnapshotSha256?: string;
  walletSnapshotSha256?: string;
  physicalDevice: boolean;
  requiredChecksPassed: boolean;
  qualifying: boolean;
}

export interface PilotStateCoreV1 {
  schemaVersion: 1;
  pilotId: string;
  evidenceId: string;
  startedAt: string;
  firstPassingRunAt?: string;
  runs: PilotRunEvidenceV1[];
}

export interface PilotStateV1 extends PilotStateCoreV1 {
  integritySha256: string;
}

export interface PilotMetricsV1 {
  runAttempts: number;
  qualifyingRuns: number;
  passRate: number;
  consecutivePasses: number;
  medianRunDurationMs: number | null;
  setupDurationMs: number | null;
  executionFingerprintSha256: string | null;
  setupTargetMet: boolean;
  runtimeTargetMet: boolean;
  repeatabilityTargetMet: boolean;
}

export interface PilotTechnicalGate {
  profile: "external-mwa-pilot";
  qualified: boolean;
  latestReadiness: PilotRunEvidenceV1["readiness"] | null;
  trailingMwaPasses: number;
  requiredTrailingMwaPasses: 3;
  setupDurationMs: number | null;
  medianRunDurationMs: number | null;
  setupTargetMet: boolean;
  runtimeTargetMet: boolean;
  repeatabilityTargetMet: boolean;
}

export interface ExternalGrantGateStatus {
  status: "not-established";
  grantReady: false;
  publisherAttestation: "not-established";
  threeIndependentPublishers: "not-established";
  confirmedDefect: "not-established";
  seekerAttestation: "not-established";
  publicRelease: "not-established";
}

export interface PublicPilotEvidenceV1 {
  schemaVersion: 1;
  kind: "launchrig-pilot-evidence";
  evidenceId: string;
  claimStatus: "self-recorded-unattested";
  metrics: PilotMetricsV1;
  runs: Array<{
    runId: string;
    outcome: PilotRunEvidenceV1["outcome"];
    readiness: PilotRunEvidenceV1["readiness"];
    durationMs: number;
    failureKind?: PilotRunEvidenceV1["failureKind"];
    launchRigVersion?: string;
    physicalDevice: boolean;
    requiredChecksPassed: boolean;
    qualifying: boolean;
  }>;
  claims: {
    externalPublisher: "not-established";
    seekerHardware: "not-established";
    productionWallet: "not-established";
    seedVault: "not-established";
    confirmedDefect: "not-established";
  };
  evidenceSha256: string;
}

export type PilotProjectRunner = (configPath: string, options?: RunOptions) => Promise<RunOutput>;
