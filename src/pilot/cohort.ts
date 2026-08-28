import { lstat } from "node:fs/promises";
import {
  verifyPublicPilotEvidence,
  type VerifiedPublicPilotEvidence,
} from "./public-evidence.js";
import { PilotError } from "./store.js";

const MAX_COHORT_EVIDENCE_FILES = 25;
const MAX_PUBLIC_EVIDENCE_BYTES = 256n * 1024n;
const REQUIRED_TECHNICAL_EVIDENCE_FILES = 3;

export const COHORT_LIMITATIONS = [
  "The cohort verifies internal consistency of self-recorded evidence only.",
  "Distinct file identities and evidence IDs do not prove distinct publishers or projects.",
  "Publisher identity, authority, consent, independence, and sharing permission require private operator review.",
  "Defect confirmation, Seeker attestation, and public-release readiness remain not established.",
  "A met self-recorded technical threshold does not establish the external grant gate.",
] as const;

export class CohortError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 2 | 3 = 2,
  ) {
    super(message);
    this.name = "CohortError";
  }
}

export type CohortTechnicalStatus = "qualified" | "not-qualified" | "not-recomputable";

export interface CohortEvidenceVerification {
  index: number;
  evidenceId: string;
  schemaVersion: 1 | 2;
  claimStatus: "self-recorded-unattested";
  internalConsistencyValid: true;
  technicalStatus: CohortTechnicalStatus;
  technicalProfile: "external-mwa-pilot-v1" | null;
  setupDurationMs: number | null;
  medianRunDurationMs: number | null;
  trailingMwaPasses: number | null;
}

export interface CohortVerificationOutput {
  schemaVersion: 1;
  kind: "launchrig-cohort-verification";
  profile: "phase-2b-external-pilots-v1";
  evidence: CohortEvidenceVerification[];
  summary: {
    submittedEvidenceFiles: number;
    uniqueEvidenceIds: number;
    recomputableV2Files: number;
    technicallyQualifiedFiles: number;
    requiredTechnicallyQualifiedFiles: 3;
    selfRecordedTechnicalThresholdMet: boolean;
  };
  externalGrantGate: {
    status: "not-established";
    threeIndependentPublishers: "not-established";
    publisherConsent: "not-established";
    confirmedDefectAcrossTwoProjects: "not-established";
    seekerAttestation: "not-established";
    publicRelease: "not-established";
  };
  grantReady: false;
  limitations: string[];
}

interface EvidenceFileSnapshot {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

function sameSnapshot(left: EvidenceFileSnapshot, right: EvidenceFileSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

async function snapshotEvidenceFile(inputPath: string, index: number): Promise<EvidenceFileSnapshot> {
  if (
    typeof inputPath !== "string" ||
    inputPath.length === 0 ||
    inputPath.length > 4096 ||
    /[\u0000\r\n]/.test(inputPath)
  ) {
    throw new CohortError("Evidence file " + index + " has an invalid path");
  }
  try {
    const metadata = await lstat(inputPath, { bigint: true });
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size < 1n ||
      metadata.size > MAX_PUBLIC_EVIDENCE_BYTES
    ) {
      throw new Error("unsafe evidence file");
    }
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      size: metadata.size,
      mtimeNs: metadata.mtimeNs,
    };
  } catch {
    throw new CohortError("Evidence file " + index + " cannot be read safely", 3);
  }
}

function cohortEvidenceEntry(
  verified: VerifiedPublicPilotEvidence,
  index: number,
): CohortEvidenceVerification {
  if (verified.schemaVersion === 1) {
    return {
      index,
      evidenceId: verified.evidenceId,
      schemaVersion: 1,
      claimStatus: "self-recorded-unattested",
      internalConsistencyValid: true,
      technicalStatus: "not-recomputable",
      technicalProfile: null,
      setupDurationMs: null,
      medianRunDurationMs: null,
      trailingMwaPasses: null,
    };
  }
  if (!verified.technicalPilot) {
    throw new Error("Verified evidence v2 is missing its technical pilot result.");
  }
  return {
    index,
    evidenceId: verified.evidenceId,
    schemaVersion: 2,
    claimStatus: "self-recorded-unattested",
    internalConsistencyValid: true,
    technicalStatus: verified.reportedTechnicalTargetsMet ? "qualified" : "not-qualified",
    technicalProfile: verified.technicalPilot.profile,
    setupDurationMs: verified.technicalPilot.setupDurationMs,
    medianRunDurationMs: verified.technicalPilot.medianRunDurationMs,
    trailingMwaPasses: verified.technicalPilot.trailingMwaPasses,
  };
}

export async function verifyCohortEvidence(
  inputPaths: readonly string[],
  verifyEvidence: typeof verifyPublicPilotEvidence = verifyPublicPilotEvidence,
): Promise<CohortVerificationOutput> {
  if (
    !Array.isArray(inputPaths) ||
    inputPaths.length < 1 ||
    inputPaths.length > MAX_COHORT_EVIDENCE_FILES
  ) {
    throw new CohortError("cohort verify requires from 1 to 25 evidence files");
  }

  const fileIdentities = new Set<string>();
  const evidenceIds = new Set<string>();
  const evidence: CohortEvidenceVerification[] = [];
  for (let position = 0; position < inputPaths.length; position += 1) {
    const index = position + 1;
    const inputPath = inputPaths[position];
    if (!inputPath) throw new CohortError("Evidence file " + index + " has an invalid path");
    const before = await snapshotEvidenceFile(inputPath, index);
    const fileIdentity = before.dev.toString() + ":" + before.ino.toString();
    if (fileIdentities.has(fileIdentity)) {
      throw new CohortError("Evidence file " + index + " duplicates a previously submitted file identity");
    }
    fileIdentities.add(fileIdentity);

    let verified: VerifiedPublicPilotEvidence;
    try {
      verified = await verifyEvidence(inputPath);
    } catch (error) {
      if (error instanceof PilotError) {
        throw new CohortError("Evidence file " + index + " failed verification: " + error.message, error.exitCode);
      }
      throw error;
    }
    const after = await snapshotEvidenceFile(inputPath, index);
    if (!sameSnapshot(before, after)) {
      throw new CohortError("Evidence file " + index + " changed during cohort verification", 3);
    }
    if (evidenceIds.has(verified.evidenceId)) {
      throw new CohortError("Evidence file " + index + " duplicates a previously submitted evidence ID");
    }
    evidenceIds.add(verified.evidenceId);
    evidence.push(cohortEvidenceEntry(verified, index));
  }

  const recomputableV2Files = evidence.filter((entry) => entry.schemaVersion === 2).length;
  const technicallyQualifiedFiles = evidence.filter((entry) => entry.technicalStatus === "qualified").length;
  return {
    schemaVersion: 1,
    kind: "launchrig-cohort-verification",
    profile: "phase-2b-external-pilots-v1",
    evidence,
    summary: {
      submittedEvidenceFiles: evidence.length,
      uniqueEvidenceIds: evidenceIds.size,
      recomputableV2Files,
      technicallyQualifiedFiles,
      requiredTechnicallyQualifiedFiles: REQUIRED_TECHNICAL_EVIDENCE_FILES,
      selfRecordedTechnicalThresholdMet:
        technicallyQualifiedFiles >= REQUIRED_TECHNICAL_EVIDENCE_FILES,
    },
    externalGrantGate: {
      status: "not-established",
      threeIndependentPublishers: "not-established",
      publisherConsent: "not-established",
      confirmedDefectAcrossTwoProjects: "not-established",
      seekerAttestation: "not-established",
      publicRelease: "not-established",
    },
    grantReady: false,
    limitations: [...COHORT_LIMITATIONS],
  };
}
