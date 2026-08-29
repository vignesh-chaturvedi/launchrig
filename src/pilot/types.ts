import type { RunOptions, RunOutput } from "../runner/orchestrator.js";

export interface PilotRunEvidenceV1 {
  runId: string;
  recordedAt: string;
  outcome: "passed" | "failed" | "setup-error";
  readiness: "Android Device Ready" | "Android/MWA Ready" | "Not Ready";
  durationMs: number;
  reportSha256?: string;
  failureKind?: "runner-error" | "input-mutation" | "report-invalid" | "scope-mismatch";
  configSha256: string;
  flowSha256: Record<string, string>;
  appArtifactSha256?: string;
  walletArtifactSha256?: string;
  launchRigVersion?: string;
  appSnapshotSha256?: string;
  walletSnapshotSha256?: string;
  sessionScopeSha256?: string;
  sessionScopeFileSha256?: string;
  scopeInputsMatched?: boolean;
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
  profile: "external-mwa-pilot-v1";
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

export interface PublicPilotClaims {
  externalPublisher: "not-established";
  seekerHardware: "not-established";
  productionWallet: "not-established";
  seedVault: "not-established";
  confirmedDefect: "not-established";
}

export interface PublicPilotRunV1 {
  runId: string;
  outcome: PilotRunEvidenceV1["outcome"];
  readiness: PilotRunEvidenceV1["readiness"];
  durationMs: number;
  failureKind?: PilotRunEvidenceV1["failureKind"];
  launchRigVersion?: string;
  physicalDevice: boolean;
  requiredChecksPassed: boolean;
  qualifying: boolean;
}

export interface PublicPilotEvidenceV1 {
  schemaVersion: 1;
  kind: "launchrig-pilot-evidence";
  evidenceId: string;
  claimStatus: "self-recorded-unattested";
  metrics: PilotMetricsV1;
  runs: PublicPilotRunV1[];
  claims: PublicPilotClaims;
  evidenceSha256: string;
}

export interface PublicPilotRunV2 extends PublicPilotRunV1 {
  elapsedSinceStartMs: number;
  executionFingerprintSha256: string | null;
}

export interface PublicPilotEvidenceV2 {
  schemaVersion: 2;
  kind: "launchrig-pilot-evidence";
  evidenceId: string;
  claimStatus: "self-recorded-unattested";
  metrics: PilotMetricsV1;
  technicalPilot: PilotTechnicalGate;
  runs: PublicPilotRunV2[];
  claims: PublicPilotClaims;
  evidenceSha256: string;
}

export interface PublicPilotRunV3 extends PublicPilotRunV2 {
  sessionScopeSha256: string;
  scopeInputsMatched: boolean;
}

export interface PublicPilotEvidenceV3 {
  schemaVersion: 3;
  kind: "launchrig-pilot-evidence";
  evidenceId: string;
  claimStatus: "self-recorded-unattested";
  sessionScope: {
    profile: "external-mwa-pilot-scope-v1";
    scopeSha256: string;
    claimStatus: "operator-prepared-unattested";
  };
  metrics: PilotMetricsV1;
  technicalPilot: PilotTechnicalGate;
  runs: PublicPilotRunV3[];
  claims: PublicPilotClaims;
  evidenceSha256: string;
}

export type PublicPilotEvidence = PublicPilotEvidenceV1 | PublicPilotEvidenceV2 | PublicPilotEvidenceV3;

export type PilotProjectRunner = (configPath: string, options?: RunOptions) => Promise<RunOutput>;
