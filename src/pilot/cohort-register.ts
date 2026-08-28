import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import {
  verifyPublicPilotEvidenceWithBinding,
  type BoundVerifiedPublicPilotEvidence,
} from "./public-evidence.js";
import { PilotError, sha256Value } from "./store.js";

const MAX_REGISTER_BYTES = 512 * 1024;
const MAX_CANDIDATES = 25;
const MAX_DEFECTS = 25;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EVIDENCE_ID = UUID_V4;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const RECRUITMENT_STATUSES = [
  "screening",
  "invited",
  "interest-recorded",
  "declined",
  "paused",
  "screened-out",
] as const;
const INTAKE_STATUSES = [
  "not-reviewed",
  "needs-review",
  "operator-recorded-sufficient",
  "operator-recorded-insufficient",
] as const;
const INDEPENDENCE_STATUSES = [
  "not-reviewed",
  "needs-review",
  "operator-recorded-eligible",
  "operator-recorded-related",
  "operator-recorded-ineligible",
] as const;
const CONSENT_STATUSES = [
  "not-requested",
  "pending",
  "operator-recorded-active",
  "operator-recorded-expired",
  "operator-recorded-withdrawn",
  "operator-recorded-superseded",
] as const;
const SESSION_STATUSES = [
  "not-scheduled",
  "scheduled",
  "ready",
  "completed",
  "stopped",
  "cancelled",
] as const;
const SHARING_STATUSES = [
  "not-reviewed",
  "private-only",
  "operator-recorded-approved",
  "operator-recorded-denied",
  "operator-recorded-withdrawn",
] as const;
const CLOSEOUT_STATUSES = ["not-required", "pending", "operator-recorded-complete"] as const;
const COUNT_STATUSES = [
  "not-reviewed",
  "operator-recorded-include",
  "operator-recorded-exclude",
  "operator-recorded-hold",
] as const;
const DEFECT_STATUSES = [
  "suspected",
  "operator-recorded-one-project-reproduction",
  "operator-recorded-cross-project-reproduction",
  "operator-recorded-not-a-defect",
  "operator-recorded-withdrawn",
] as const;
const RELATIONSHIP_CODES = [
  "none-declared",
  "same-control",
  "same-project",
  "agency-client",
  "shared-repository",
  "fork",
  "white-label",
  "shared-maintainers",
  "shared-release-operator",
  "shared-mwa-code",
  "prior-pilot",
  "compensated",
  "prior-relationship",
  "other-documented",
] as const;
const REASON_CODES = [
  "meets-recorded-policy",
  "authority-unresolved",
  "consent-inactive",
  "session-incomplete",
  "evidence-unavailable",
  "sharing-not-approved",
  "related-publisher",
  "related-project",
  "lineage-unresolved",
  "unsafe-or-unsupported",
  "technical-result-unavailable",
  "technical-result-not-qualified",
  "withdrawn",
  "other-documented",
] as const;

type RecruitmentStatus = (typeof RECRUITMENT_STATUSES)[number];
type IntakeStatus = (typeof INTAKE_STATUSES)[number];
type IndependenceStatus = (typeof INDEPENDENCE_STATUSES)[number];
type ConsentStatus = (typeof CONSENT_STATUSES)[number];
type SessionStatus = (typeof SESSION_STATUSES)[number];
type SharingStatus = (typeof SHARING_STATUSES)[number];
type CloseoutStatus = (typeof CLOSEOUT_STATUSES)[number];
type CountStatus = (typeof COUNT_STATUSES)[number];
type DefectStatus = (typeof DEFECT_STATUSES)[number];
type RelationshipCode = (typeof RELATIONSHIP_CODES)[number];
type ReasonCode = (typeof REASON_CODES)[number];

export const COHORT_REGISTER_LIMITATIONS = [
  "The audit verifies internal consistency of private operator-recorded metadata and supplied self-recorded evidence only.",
  "Opaque references and digests do not authenticate people, organizations, projects, authority, consent, or independence.",
  "Technical qualification is recomputed from self-recorded evidence fields and is not an external attestation.",
  "Relationship truth, defect causality, Seeker hardware, and public-release readiness still require permissioned human evidence.",
  "File ownership and mode checks do not prove ACL, backup, sync, or cloud-storage privacy.",
  "The audit does not grant publication permission or grant readiness.",
] as const;

export const COHORT_REGISTER_BLOCKERS = [
  "recruitment-not-interest-recorded",
  "intake-not-sufficient",
  "independence-not-eligible",
  "relationship-disclosure-required",
  "consent-not-active",
  "consent-not-current",
  "session-not-completed",
  "session-binding-missing",
  "evidence-binding-missing",
  "evidence-not-supplied",
  "evidence-v1-not-recomputable",
  "evidence-v2-not-qualified",
  "sharing-not-approved",
  "closeout-not-complete",
  "count-decision-not-include",
  "count-decision-metadata-incomplete",
  "governance-metadata-incomplete",
  "lifecycle-date-inconsistent",
  "duplicate-included-publisher",
  "duplicate-included-project",
  "withdrawal-recorded",
] as const;

export const COHORT_DEFECT_BLOCKERS = [
  "defect-decision-metadata-incomplete",
  "defect-reproduction-insufficient",
  "defect-reproduction-candidate-not-included",
  "defect-reproduction-evidence-not-qualified",
  "defect-reproduction-sharing-not-approved",
  "defect-reproduction-not-independent",
  "defect-withdrawal-recorded",
] as const;

export type CohortRegisterBlocker = (typeof COHORT_REGISTER_BLOCKERS)[number];
export type CohortDefectBlocker = (typeof COHORT_DEFECT_BLOCKERS)[number];

export class CohortRegisterError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 2 | 3 = 2,
  ) {
    super(message);
    this.name = "CohortRegisterError";
  }
}

interface RecordedRecruitment {
  status: RecruitmentStatus;
  recordSha256: string | null;
  statusOn: string | null;
}

interface RecordedReview<TStatus extends string> {
  status: TStatus;
  recordSha256: string | null;
  reviewedOn: string | null;
  reviewerRef: string | null;
}

interface RecordedIndependence extends RecordedReview<IndependenceStatus> {
  relationshipCodes: RelationshipCode[];
}

interface RecordedConsent {
  status: ConsentStatus;
  recordSha256: string | null;
  scopeSha256: string | null;
  effectiveOn: string | null;
  expiresOn: string | null;
  withdrawalRecordSha256: string | null;
  withdrawnOn: string | null;
}

interface SessionBinding {
  bundleId: string;
  packageSha256: string;
  appBuildSha256: string;
  walletArtifactSha256: string;
  flowReviewSha256: string;
  scopeSha256: string;
}

interface RecordedSession {
  status: SessionStatus;
  statusOn: string | null;
  binding: SessionBinding | null;
}

interface EvidenceBinding {
  evidenceId: string;
  fileSha256: string;
  evidenceSha256: string;
  schemaVersion: 1 | 2;
}

interface RecordedEvidence {
  sharingStatus: SharingStatus;
  binding: EvidenceBinding | null;
  decisionRecordSha256: string | null;
  decidedOn: string | null;
  withdrawalRecordSha256: string | null;
  withdrawnOn: string | null;
}

interface RecordedCloseout {
  status: CloseoutStatus;
  recordSha256: string | null;
  completedOn: string | null;
}

interface RecordedCountDecision extends RecordedReview<CountStatus> {
  reasonCodes: ReasonCode[];
}

interface PrivateCohortCandidate {
  candidateRef: string;
  publisherRef: string;
  projectRef: string;
  lineageRef: string;
  pilotRef: string;
  recruitment: RecordedRecruitment;
  intakeReview: RecordedReview<IntakeStatus>;
  independenceReview: RecordedIndependence;
  consent: RecordedConsent;
  session: RecordedSession;
  evidence: RecordedEvidence;
  closeout: RecordedCloseout;
  countDecision: RecordedCountDecision;
}

interface DefectReproduction {
  candidateRef: string;
  defectRecordSha256: string;
  sharingStatus: SharingStatus;
  sharingDecisionRecordSha256: string | null;
}

interface PrivateCohortDefect {
  defectRef: string;
  status: DefectStatus;
  decisionRecordSha256: string | null;
  reviewedOn: string | null;
  reviewerRef: string | null;
  reproductions: DefectReproduction[];
}

interface PrivateCohortRegisterCore {
  schemaVersion: 1;
  kind: "launchrig-private-cohort-register";
  profile: "phase-2c-publisher-governance-v1";
  privacyProfile: "opaque-refs-digests-dates-v1";
  registerRef: string;
  revision: number;
  asOfDate: string;
  operatorRef: string;
  candidates: PrivateCohortCandidate[];
  defects: PrivateCohortDefect[];
}

interface PrivateCohortRegister extends PrivateCohortRegisterCore {
  integritySha256: string | null;
}

export interface CohortRegisterAuditOutput {
  schemaVersion: 1;
  kind: "launchrig-private-cohort-register-audit";
  profile: "phase-2c-publisher-governance-v1";
  register: {
    fileSha256: string;
    contentSha256: string;
    revision: number;
    integrityRecorded: boolean;
    privacyShapeValid: true;
    structuralConsistencyValid: true;
  };
  entries: Array<{
    index: number;
    recordedCountDecision: CountStatus;
    governanceStatus: "recorded-ready" | "recorded-blocked" | "recorded-not-selected";
    evidenceStatus:
      | "not-bound"
      | "not-supplied"
      | "matched-v1-not-recomputable"
      | "matched-v2-qualified"
      | "matched-v2-not-qualified";
    blockers: CohortRegisterBlocker[];
  }>;
  defects: Array<{
    index: number;
    recordedStatus: DefectStatus;
    structuralStatus: "consistent" | "blocked";
    qualifiedReproductionBindings: number;
    blockers: CohortDefectBlocker[];
  }>;
  summary: {
    candidateRecords: number;
    interestRecorded: number;
    activeConsentRecorded: number;
    completedSessionsRecorded: number;
    sharingApprovedRecorded: number;
    recordedIncludedCandidates: number;
    suppliedEvidenceFiles: number;
    matchedEvidenceBindings: number;
    recomputedQualifiedV2Bindings: number;
    recordedIncludedWithQualifiedV2: number;
    distinctRecordedPublishersForQualifiedIncluded: number;
    distinctRecordedProjectsForQualifiedIncluded: number;
    requiredPublisherProjects: 3;
    recordedGovernanceAndTechnicalThresholdMet: boolean;
    defectRecords: number;
    recordedCrossProjectDefectReviews: number;
    recordedCrossProjectDefectReviewsWithQualifiedBindings: number;
  };
  externalGrantGate: {
    status: "not-established";
    publisherIdentity: "not-established";
    publisherAuthority: "not-established";
    publisherConsent: "not-established";
    publisherIndependence: "not-established";
    confirmedDefectAcrossTwoProjects: "not-established";
    seekerAttestation: "not-established";
    publicRelease: "not-established";
  };
  grantReady: false;
  limitations: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactRecord(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new CohortRegisterError(label + " must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new CohortRegisterError(label + " must contain the exact supported fields");
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new CohortRegisterError(label + " is invalid");
  }
  return value as T;
}

function nullableHash(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new CohortRegisterError(label + " must be null or a lowercase SHA-256 digest");
  }
  return value;
}

function requiredHash(value: unknown, label: string): string {
  const digest = nullableHash(value, label);
  if (!digest) throw new CohortRegisterError(label + " must be a lowercase SHA-256 digest");
  return digest;
}

function strictDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !DATE.test(value)) throw new CohortRegisterError(label + " is invalid");
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new CohortRegisterError(label + " is invalid");
  }
  return value;
}

function nullableDate(value: unknown, label: string): string | null {
  return value === null ? null : strictDate(value, label);
}

function typedRef(value: unknown, kind: string, label: string): string {
  if (typeof value !== "string") throw new CohortRegisterError(label + " is invalid");
  const prefix = "urn:launchrig:" + kind + ":";
  if (!value.startsWith(prefix) || !UUID_V4.test(value.slice(prefix.length))) {
    throw new CohortRegisterError(label + " is invalid");
  }
  return value;
}

function nullableTypedRef(value: unknown, kind: string, label: string): string | null {
  return value === null ? null : typedRef(value, kind, label);
}

function parseRecruitment(value: unknown, index: number): RecordedRecruitment {
  const record = exactRecord(value, ["status", "recordSha256", "statusOn"], "candidate " + index + " recruitment");
  return {
    status: enumValue(record.status, RECRUITMENT_STATUSES, "candidate " + index + " recruitment status"),
    recordSha256: nullableHash(record.recordSha256, "candidate " + index + " recruitment record"),
    statusOn: nullableDate(record.statusOn, "candidate " + index + " recruitment date"),
  };
}

function parseReview<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): RecordedReview<T> {
  const record = exactRecord(value, ["status", "recordSha256", "reviewedOn", "reviewerRef"], label);
  return {
    status: enumValue(record.status, allowed, label + " status"),
    recordSha256: nullableHash(record.recordSha256, label + " record"),
    reviewedOn: nullableDate(record.reviewedOn, label + " date"),
    reviewerRef: nullableTypedRef(record.reviewerRef, "reviewer", label + " reviewer"),
  };
}

function parseIndependence(value: unknown, index: number): RecordedIndependence {
  const label = "candidate " + index + " independence review";
  const record = exactRecord(
    value,
    ["status", "recordSha256", "reviewedOn", "reviewerRef", "relationshipCodes"],
    label,
  );
  if (!Array.isArray(record.relationshipCodes) || record.relationshipCodes.length < 1 || record.relationshipCodes.length > 14) {
    throw new CohortRegisterError(label + " relationship codes are invalid");
  }
  const relationshipCodes = record.relationshipCodes.map((entry) =>
    enumValue(entry, RELATIONSHIP_CODES, label + " relationship code"),
  );
  if (new Set(relationshipCodes).size !== relationshipCodes.length) {
    throw new CohortRegisterError(label + " relationship codes must be unique");
  }
  if (relationshipCodes.includes("none-declared") && relationshipCodes.length !== 1) {
    throw new CohortRegisterError(label + " none-declared code must stand alone");
  }
  return {
    status: enumValue(record.status, INDEPENDENCE_STATUSES, label + " status"),
    recordSha256: nullableHash(record.recordSha256, label + " record"),
    reviewedOn: nullableDate(record.reviewedOn, label + " date"),
    reviewerRef: nullableTypedRef(record.reviewerRef, "reviewer", label + " reviewer"),
    relationshipCodes,
  };
}

function parseConsent(value: unknown, index: number): RecordedConsent {
  const label = "candidate " + index + " consent";
  const record = exactRecord(
    value,
    [
      "status",
      "recordSha256",
      "scopeSha256",
      "effectiveOn",
      "expiresOn",
      "withdrawalRecordSha256",
      "withdrawnOn",
    ],
    label,
  );
  return {
    status: enumValue(record.status, CONSENT_STATUSES, label + " status"),
    recordSha256: nullableHash(record.recordSha256, label + " record"),
    scopeSha256: nullableHash(record.scopeSha256, label + " scope"),
    effectiveOn: nullableDate(record.effectiveOn, label + " effective date"),
    expiresOn: nullableDate(record.expiresOn, label + " expiry date"),
    withdrawalRecordSha256: nullableHash(record.withdrawalRecordSha256, label + " withdrawal record"),
    withdrawnOn: nullableDate(record.withdrawnOn, label + " withdrawal date"),
  };
}

function parseSessionBinding(value: unknown, index: number): SessionBinding | null {
  if (value === null) return null;
  const label = "candidate " + index + " session binding";
  const record = exactRecord(
    value,
    ["bundleId", "packageSha256", "appBuildSha256", "walletArtifactSha256", "flowReviewSha256", "scopeSha256"],
    label,
  );
  if (typeof record.bundleId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.bundleId)) {
    throw new CohortRegisterError(label + " bundle ID is invalid");
  }
  return {
    bundleId: record.bundleId,
    packageSha256: requiredHash(record.packageSha256, label + " package"),
    appBuildSha256: requiredHash(record.appBuildSha256, label + " app build"),
    walletArtifactSha256: requiredHash(record.walletArtifactSha256, label + " wallet artifact"),
    flowReviewSha256: requiredHash(record.flowReviewSha256, label + " flow review"),
    scopeSha256: requiredHash(record.scopeSha256, label + " scope"),
  };
}

function parseSession(value: unknown, index: number): RecordedSession {
  const label = "candidate " + index + " session";
  const record = exactRecord(value, ["status", "statusOn", "binding"], label);
  return {
    status: enumValue(record.status, SESSION_STATUSES, label + " status"),
    statusOn: nullableDate(record.statusOn, label + " date"),
    binding: parseSessionBinding(record.binding, index),
  };
}

function parseEvidenceBinding(value: unknown, index: number): EvidenceBinding | null {
  if (value === null) return null;
  const label = "candidate " + index + " evidence binding";
  const record = exactRecord(value, ["evidenceId", "fileSha256", "evidenceSha256", "schemaVersion"], label);
  if (typeof record.evidenceId !== "string" || !EVIDENCE_ID.test(record.evidenceId)) {
    throw new CohortRegisterError(label + " evidence ID is invalid");
  }
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    throw new CohortRegisterError(label + " schema version is invalid");
  }
  return {
    evidenceId: record.evidenceId,
    fileSha256: requiredHash(record.fileSha256, label + " file"),
    evidenceSha256: requiredHash(record.evidenceSha256, label + " integrity"),
    schemaVersion: record.schemaVersion,
  };
}

function parseEvidence(value: unknown, index: number): RecordedEvidence {
  const label = "candidate " + index + " evidence";
  const record = exactRecord(
    value,
    ["sharingStatus", "binding", "decisionRecordSha256", "decidedOn", "withdrawalRecordSha256", "withdrawnOn"],
    label,
  );
  return {
    sharingStatus: enumValue(record.sharingStatus, SHARING_STATUSES, label + " sharing status"),
    binding: parseEvidenceBinding(record.binding, index),
    decisionRecordSha256: nullableHash(record.decisionRecordSha256, label + " decision record"),
    decidedOn: nullableDate(record.decidedOn, label + " decision date"),
    withdrawalRecordSha256: nullableHash(record.withdrawalRecordSha256, label + " withdrawal record"),
    withdrawnOn: nullableDate(record.withdrawnOn, label + " withdrawal date"),
  };
}

function parseCloseout(value: unknown, index: number): RecordedCloseout {
  const label = "candidate " + index + " closeout";
  const record = exactRecord(value, ["status", "recordSha256", "completedOn"], label);
  return {
    status: enumValue(record.status, CLOSEOUT_STATUSES, label + " status"),
    recordSha256: nullableHash(record.recordSha256, label + " record"),
    completedOn: nullableDate(record.completedOn, label + " date"),
  };
}

function parseCountDecision(value: unknown, index: number): RecordedCountDecision {
  const label = "candidate " + index + " count decision";
  const record = exactRecord(
    value,
    ["status", "recordSha256", "reviewedOn", "reviewerRef", "reasonCodes"],
    label,
  );
  if (!Array.isArray(record.reasonCodes) || record.reasonCodes.length > 14) {
    throw new CohortRegisterError(label + " reason codes are invalid");
  }
  const reasonCodes = record.reasonCodes.map((entry) => enumValue(entry, REASON_CODES, label + " reason code"));
  if (new Set(reasonCodes).size !== reasonCodes.length) {
    throw new CohortRegisterError(label + " reason codes must be unique");
  }
  return {
    status: enumValue(record.status, COUNT_STATUSES, label + " status"),
    recordSha256: nullableHash(record.recordSha256, label + " record"),
    reviewedOn: nullableDate(record.reviewedOn, label + " date"),
    reviewerRef: nullableTypedRef(record.reviewerRef, "reviewer", label + " reviewer"),
    reasonCodes,
  };
}

function parseCandidate(value: unknown, index: number): PrivateCohortCandidate {
  const label = "candidate " + index;
  const record = exactRecord(
    value,
    [
      "candidateRef",
      "publisherRef",
      "projectRef",
      "lineageRef",
      "pilotRef",
      "recruitment",
      "intakeReview",
      "independenceReview",
      "consent",
      "session",
      "evidence",
      "closeout",
      "countDecision",
    ],
    label,
  );
  return {
    candidateRef: typedRef(record.candidateRef, "candidate", label + " reference"),
    publisherRef: typedRef(record.publisherRef, "publisher", label + " publisher reference"),
    projectRef: typedRef(record.projectRef, "project", label + " project reference"),
    lineageRef: typedRef(record.lineageRef, "lineage", label + " lineage reference"),
    pilotRef: typedRef(record.pilotRef, "pilot", label + " pilot reference"),
    recruitment: parseRecruitment(record.recruitment, index),
    intakeReview: parseReview(record.intakeReview, INTAKE_STATUSES, label + " intake review"),
    independenceReview: parseIndependence(record.independenceReview, index),
    consent: parseConsent(record.consent, index),
    session: parseSession(record.session, index),
    evidence: parseEvidence(record.evidence, index),
    closeout: parseCloseout(record.closeout, index),
    countDecision: parseCountDecision(record.countDecision, index),
  };
}

function parseDefectReproduction(value: unknown, defectIndex: number, reproductionIndex: number): DefectReproduction {
  const label = "defect " + defectIndex + " reproduction " + reproductionIndex;
  const record = exactRecord(
    value,
    ["candidateRef", "defectRecordSha256", "sharingStatus", "sharingDecisionRecordSha256"],
    label,
  );
  return {
    candidateRef: typedRef(record.candidateRef, "candidate", label + " candidate reference"),
    defectRecordSha256: requiredHash(record.defectRecordSha256, label + " record"),
    sharingStatus: enumValue(record.sharingStatus, SHARING_STATUSES, label + " sharing status"),
    sharingDecisionRecordSha256: nullableHash(record.sharingDecisionRecordSha256, label + " sharing decision"),
  };
}

function parseDefect(value: unknown, index: number): PrivateCohortDefect {
  const label = "defect " + index;
  const record = exactRecord(
    value,
    ["defectRef", "status", "decisionRecordSha256", "reviewedOn", "reviewerRef", "reproductions"],
    label,
  );
  if (!Array.isArray(record.reproductions) || record.reproductions.length > MAX_CANDIDATES) {
    throw new CohortRegisterError(label + " reproductions are invalid");
  }
  const reproductions = record.reproductions.map((entry, reproductionIndex) =>
    parseDefectReproduction(entry, index, reproductionIndex + 1),
  );
  if (new Set(reproductions.map((entry) => entry.candidateRef)).size !== reproductions.length) {
    throw new CohortRegisterError(label + " contains duplicate candidate reproductions");
  }
  return {
    defectRef: typedRef(record.defectRef, "defect", label + " reference"),
    status: enumValue(record.status, DEFECT_STATUSES, label + " status"),
    decisionRecordSha256: nullableHash(record.decisionRecordSha256, label + " decision record"),
    reviewedOn: nullableDate(record.reviewedOn, label + " review date"),
    reviewerRef: nullableTypedRef(record.reviewerRef, "reviewer", label + " reviewer"),
    reproductions,
  };
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new CohortRegisterError(label + " must be unique");
}

function assertUniqueNonNull(values: readonly (string | null)[], label: string): void {
  assertUnique(values.filter((value): value is string => value !== null), label);
}

function parseRegister(value: unknown): { register: PrivateCohortRegister; contentSha256: string } {
  const record = exactRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "profile",
      "privacyProfile",
      "registerRef",
      "revision",
      "asOfDate",
      "operatorRef",
      "candidates",
      "defects",
      "integritySha256",
    ],
    "private cohort register",
  );
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "launchrig-private-cohort-register" ||
    record.profile !== "phase-2c-publisher-governance-v1" ||
    record.privacyProfile !== "opaque-refs-digests-dates-v1"
  ) {
    throw new CohortRegisterError("Private cohort register schema identity is invalid");
  }
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1 || (record.revision as number) > 1_000_000) {
    throw new CohortRegisterError("Private cohort register revision is invalid");
  }
  if (!Array.isArray(record.candidates) || record.candidates.length > MAX_CANDIDATES) {
    throw new CohortRegisterError("Private cohort register candidates must contain at most 25 entries");
  }
  if (!Array.isArray(record.defects) || record.defects.length > MAX_DEFECTS) {
    throw new CohortRegisterError("Private cohort register defects must contain at most 25 entries");
  }
  const candidates = record.candidates.map((entry, index) => parseCandidate(entry, index + 1));
  const defects = record.defects.map((entry, index) => parseDefect(entry, index + 1));
  assertUnique(candidates.map((entry) => entry.candidateRef), "Candidate references");
  assertUnique(candidates.map((entry) => entry.pilotRef), "Pilot references");
  assertUnique(defects.map((entry) => entry.defectRef), "Defect references");
  assertUniqueNonNull(candidates.map((entry) => entry.evidence.binding?.evidenceId ?? null), "Evidence IDs");
  assertUniqueNonNull(candidates.map((entry) => entry.evidence.binding?.fileSha256 ?? null), "Evidence file digests");
  assertUniqueNonNull(candidates.map((entry) => entry.evidence.binding?.evidenceSha256 ?? null), "Evidence integrity digests");
  assertUniqueNonNull(candidates.map((entry) => entry.recruitment.recordSha256), "Recruitment record digests");
  assertUniqueNonNull(candidates.map((entry) => entry.intakeReview.recordSha256), "Intake record digests");
  assertUniqueNonNull(candidates.map((entry) => entry.independenceReview.recordSha256), "Independence record digests");
  assertUniqueNonNull(candidates.map((entry) => entry.consent.recordSha256), "Consent record digests");
  assertUniqueNonNull(candidates.map((entry) => entry.consent.withdrawalRecordSha256), "Consent withdrawal record digests");
  assertUniqueNonNull(candidates.map((entry) => entry.evidence.decisionRecordSha256), "Sharing record digests");
  assertUniqueNonNull(candidates.map((entry) => entry.evidence.withdrawalRecordSha256), "Sharing withdrawal record digests");
  assertUniqueNonNull(candidates.map((entry) => entry.closeout.recordSha256), "Closeout record digests");
  assertUniqueNonNull(candidates.map((entry) => entry.countDecision.recordSha256), "Count decision record digests");
  assertUniqueNonNull(defects.map((entry) => entry.decisionRecordSha256), "Defect decision record digests");
  assertUnique(
    defects.flatMap((entry) => entry.reproductions.map((reproduction) => reproduction.defectRecordSha256)),
    "Defect reproduction record digests",
  );
  assertUniqueNonNull(
    defects.flatMap((entry) => entry.reproductions.map((reproduction) => reproduction.sharingDecisionRecordSha256)),
    "Defect sharing decision record digests",
  );
  const core: PrivateCohortRegisterCore = {
    schemaVersion: 1,
    kind: "launchrig-private-cohort-register",
    profile: "phase-2c-publisher-governance-v1",
    privacyProfile: "opaque-refs-digests-dates-v1",
    registerRef: typedRef(record.registerRef, "register", "Private cohort register reference"),
    revision: record.revision as number,
    asOfDate: strictDate(record.asOfDate, "Private cohort register as-of date"),
    operatorRef: typedRef(record.operatorRef, "operator", "Private cohort register operator reference"),
    candidates,
    defects,
  };
  const integritySha256 = nullableHash(record.integritySha256, "Private cohort register integrity");
  const contentSha256 = sha256Value(core);
  if (integritySha256 !== null && integritySha256 !== contentSha256) {
    throw new CohortRegisterError("Private cohort register integrity check failed");
  }
  return { register: { ...core, integritySha256 }, contentSha256 };
}

interface ReadRegister {
  value: unknown;
  fileSha256: string;
}

async function readPrivateRegister(inputPath: string): Promise<ReadRegister> {
  if (
    typeof inputPath !== "string" ||
    inputPath.length < 1 ||
    inputPath.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(inputPath)
  ) {
    throw new CohortRegisterError("Private cohort register path is invalid");
  }
  let handle;
  try {
    const before = await lstat(inputPath, { bigint: true });
    const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(MAX_REGISTER_BYTES) ||
      before.nlink !== 1n ||
      (currentUid !== null && before.uid !== currentUid) ||
      (process.platform !== "win32" && (before.mode & 0o077n) !== 0n)
    ) {
      throw new Error("unsafe private register");
    }
    handle = await open(
      inputPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
    );
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.nlink !== 1n ||
      (currentUid !== null && opened.uid !== currentUid) ||
      (process.platform !== "win32" && (opened.mode & 0o077n) !== 0n)
    ) {
      throw new Error("unsafe private register");
    }
    const expectedSize = Number(opened.size);
    const buffer = Buffer.alloc(expectedSize + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(inputPath, { bigint: true });
    if (
      bytesRead !== expectedSize ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.nlink !== 1n ||
      (currentUid !== null && after.uid !== currentUid) ||
      (process.platform !== "win32" && (after.mode & 0o077n) !== 0n) ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino ||
      afterPath.size !== opened.size ||
      afterPath.mtimeNs !== opened.mtimeNs ||
      afterPath.nlink !== 1n ||
      (currentUid !== null && afterPath.uid !== currentUid) ||
      (process.platform !== "win32" && (afterPath.mode & 0o077n) !== 0n)
    ) {
      throw new Error("private register changed while reading");
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, expectedSize));
    } catch {
      throw new CohortRegisterError("Private cohort register must use valid UTF-8");
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new CohortRegisterError("Private cohort register must be strict JSON");
    }
    const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new CohortRegisterError("Private cohort register must be strict JSON without duplicate keys");
    }
    return {
      value,
      fileSha256: createHash("sha256").update(buffer.subarray(0, expectedSize)).digest("hex"),
    };
  } catch (error) {
    if (error instanceof CohortRegisterError) throw error;
    throw new CohortRegisterError("Private cohort register cannot be read safely", 3);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function hasMetadata(record: RecordedReview<string>): boolean {
  return Boolean(record.recordSha256 && record.reviewedOn && record.reviewerRef);
}

function addIf(blockers: Set<CohortRegisterBlocker>, condition: boolean, code: CohortRegisterBlocker): void {
  if (condition) blockers.add(code);
}

function dateAfter(left: string | null, right: string): boolean {
  return left !== null && left > right;
}

function orderedCurrentDates(values: readonly (string | null)[], asOfDate: string): boolean {
  if (values.some((value) => value === null || value > asOfDate)) return false;
  const dates = values as string[];
  return dates.every((value, index) => index === 0 || (dates[index - 1] ?? value) <= value);
}

interface AuditedCandidate {
  candidate: PrivateCohortCandidate;
  output: CohortRegisterAuditOutput["entries"][number];
  evidence: BoundVerifiedPublicPilotEvidence | null;
  fullyQualified: boolean;
}

function duplicateIncludedReferences(candidates: readonly PrivateCohortCandidate[], key: "publisherRef" | "projectRef"): Set<string> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.countDecision.status !== "operator-recorded-include") continue;
    counts.set(candidate[key], (counts.get(candidate[key]) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value));
}

function auditCandidate(
  candidate: PrivateCohortCandidate,
  index: number,
  asOfDate: string,
  evidence: BoundVerifiedPublicPilotEvidence | null,
  duplicatePublishers: ReadonlySet<string>,
  duplicateProjects: ReadonlySet<string>,
): AuditedCandidate {
  const blockers = new Set<CohortRegisterBlocker>();
  addIf(blockers, candidate.recruitment.status !== "interest-recorded", "recruitment-not-interest-recorded");
  addIf(
    blockers,
    candidate.intakeReview.status !== "operator-recorded-sufficient",
    "intake-not-sufficient",
  );
  addIf(
    blockers,
    candidate.independenceReview.status !== "operator-recorded-eligible",
    "independence-not-eligible",
  );
  addIf(
    blockers,
    (duplicatePublishers.has(candidate.publisherRef) || duplicateProjects.has(candidate.projectRef)) &&
      candidate.independenceReview.relationshipCodes.includes("none-declared"),
    "relationship-disclosure-required",
  );
  addIf(blockers, candidate.consent.status !== "operator-recorded-active", "consent-not-active");
  addIf(
    blockers,
    candidate.consent.effectiveOn === null ||
      candidate.consent.expiresOn === null ||
      dateAfter(candidate.consent.effectiveOn, asOfDate) ||
      !dateAfter(candidate.consent.expiresOn, asOfDate) ||
      (candidate.consent.effectiveOn !== null &&
        candidate.consent.expiresOn !== null &&
        candidate.consent.effectiveOn > candidate.consent.expiresOn) ||
      candidate.consent.scopeSha256 === null ||
      candidate.consent.recordSha256 === null,
    "consent-not-current",
  );
  addIf(blockers, candidate.session.status !== "completed", "session-not-completed");
  addIf(
    blockers,
    candidate.session.binding === null ||
      candidate.session.statusOn === null ||
      candidate.consent.scopeSha256 !== candidate.session.binding?.scopeSha256,
    "session-binding-missing",
  );
  addIf(blockers, candidate.evidence.binding === null, "evidence-binding-missing");
  addIf(blockers, candidate.evidence.sharingStatus !== "operator-recorded-approved", "sharing-not-approved");
  addIf(blockers, candidate.closeout.status !== "operator-recorded-complete", "closeout-not-complete");
  addIf(blockers, candidate.countDecision.status !== "operator-recorded-include", "count-decision-not-include");
  addIf(
    blockers,
    candidate.countDecision.status === "operator-recorded-include" &&
      (!hasMetadata(candidate.countDecision) ||
        candidate.countDecision.reasonCodes.length !== 1 ||
        candidate.countDecision.reasonCodes[0] !== "meets-recorded-policy"),
    "count-decision-metadata-incomplete",
  );
  const requiredReviews = [candidate.intakeReview, candidate.independenceReview];
  addIf(
    blockers,
    candidate.recruitment.recordSha256 === null ||
      candidate.recruitment.statusOn === null ||
      requiredReviews.some((review) => !hasMetadata(review)) ||
      candidate.evidence.decisionRecordSha256 === null ||
      candidate.evidence.decidedOn === null ||
      candidate.closeout.recordSha256 === null ||
      candidate.closeout.completedOn === null,
    "governance-metadata-incomplete",
  );
  addIf(
    blockers,
    !orderedCurrentDates(
      [
        candidate.recruitment.statusOn,
        candidate.intakeReview.reviewedOn,
        candidate.independenceReview.reviewedOn,
        candidate.consent.effectiveOn,
        candidate.session.statusOn,
        candidate.evidence.decidedOn,
        candidate.closeout.completedOn,
        candidate.countDecision.reviewedOn,
      ],
      asOfDate,
    ),
    "lifecycle-date-inconsistent",
  );
  const withdrawalRecorded =
    candidate.consent.status === "operator-recorded-withdrawn" ||
    candidate.evidence.sharingStatus === "operator-recorded-withdrawn" ||
    candidate.consent.withdrawalRecordSha256 !== null ||
    candidate.consent.withdrawnOn !== null ||
    candidate.evidence.withdrawalRecordSha256 !== null ||
    candidate.evidence.withdrawnOn !== null;
  addIf(blockers, withdrawalRecorded, "withdrawal-recorded");
  addIf(blockers, duplicatePublishers.has(candidate.publisherRef), "duplicate-included-publisher");
  addIf(blockers, duplicateProjects.has(candidate.projectRef), "duplicate-included-project");

  let evidenceStatus: CohortRegisterAuditOutput["entries"][number]["evidenceStatus"] = "not-bound";
  if (candidate.evidence.binding) {
    if (!evidence) {
      evidenceStatus = "not-supplied";
      blockers.add("evidence-not-supplied");
    } else if (evidence.schemaVersion === 1) {
      evidenceStatus = "matched-v1-not-recomputable";
      blockers.add("evidence-v1-not-recomputable");
    } else if (evidence.reportedTechnicalTargetsMet) {
      evidenceStatus = "matched-v2-qualified";
    } else {
      evidenceStatus = "matched-v2-not-qualified";
      blockers.add("evidence-v2-not-qualified");
    }
  }
  const blockerList = COHORT_REGISTER_BLOCKERS.filter((code) => blockers.has(code));
  const selected = candidate.countDecision.status === "operator-recorded-include";
  const governanceBlockers = blockerList.filter(
    (code) => !["evidence-not-supplied", "evidence-v1-not-recomputable", "evidence-v2-not-qualified"].includes(code),
  );
  return {
    candidate,
    evidence,
    fullyQualified: selected && blockerList.length === 0 && evidenceStatus === "matched-v2-qualified",
    output: {
      index,
      recordedCountDecision: candidate.countDecision.status,
      governanceStatus: !selected
        ? "recorded-not-selected"
        : governanceBlockers.length === 0
          ? "recorded-ready"
          : "recorded-blocked",
      evidenceStatus,
      blockers: blockerList,
    },
  };
}

function auditDefect(
  defect: PrivateCohortDefect,
  index: number,
  candidates: ReadonlyMap<string, AuditedCandidate>,
  asOfDate: string,
): CohortRegisterAuditOutput["defects"][number] {
  const blockers = new Set<CohortDefectBlocker>();
  const decisionRecorded = Boolean(
    defect.decisionRecordSha256 &&
      defect.reviewedOn &&
      defect.reviewedOn <= asOfDate &&
      defect.reviewerRef,
  );
  if (defect.status.startsWith("operator-recorded-") && !decisionRecorded) {
    blockers.add("defect-decision-metadata-incomplete");
  }
  if (defect.status === "operator-recorded-withdrawn") blockers.add("defect-withdrawal-recorded");
  const qualified = defect.reproductions.filter((reproduction) => {
    const candidate = candidates.get(reproduction.candidateRef);
    if (!candidate?.fullyQualified) return false;
    return (
      reproduction.sharingStatus === "operator-recorded-approved" &&
      reproduction.sharingDecisionRecordSha256 !== null
    );
  });
  if (
    (defect.status === "operator-recorded-one-project-reproduction" && defect.reproductions.length < 1) ||
    (defect.status === "operator-recorded-cross-project-reproduction" && defect.reproductions.length < 2)
  ) {
    blockers.add("defect-reproduction-insufficient");
  }
  if (defect.reproductions.some((entry) => !candidates.get(entry.candidateRef)?.fullyQualified)) {
    blockers.add("defect-reproduction-candidate-not-included");
    blockers.add("defect-reproduction-evidence-not-qualified");
  }
  if (
    defect.reproductions.some(
      (entry) =>
        entry.sharingStatus !== "operator-recorded-approved" ||
        entry.sharingDecisionRecordSha256 === null,
    )
  ) {
    blockers.add("defect-reproduction-sharing-not-approved");
  }
  const qualifiedCandidates = qualified
    .map((entry) => candidates.get(entry.candidateRef))
    .filter((entry): entry is AuditedCandidate => entry !== undefined);
  if (
    defect.status === "operator-recorded-cross-project-reproduction" &&
    (new Set(qualifiedCandidates.map((entry) => entry.candidate.publisherRef)).size < 2 ||
      new Set(qualifiedCandidates.map((entry) => entry.candidate.projectRef)).size < 2 ||
      new Set(qualifiedCandidates.map((entry) => entry.candidate.lineageRef)).size < 2)
  ) {
    blockers.add("defect-reproduction-not-independent");
  }
  const blockerList = COHORT_DEFECT_BLOCKERS.filter((code) => blockers.has(code));
  return {
    index,
    recordedStatus: defect.status,
    structuralStatus: blockerList.length === 0 ? "consistent" : "blocked",
    qualifiedReproductionBindings: qualified.length,
    blockers: blockerList,
  };
}

export async function auditPrivateCohortRegister(
  registerPath: string,
  evidencePaths: readonly string[] = [],
  verifyEvidence: typeof verifyPublicPilotEvidenceWithBinding = verifyPublicPilotEvidenceWithBinding,
): Promise<CohortRegisterAuditOutput> {
  if (!Array.isArray(evidencePaths) || evidencePaths.length > MAX_CANDIDATES) {
    throw new CohortRegisterError("cohort audit accepts at most 25 evidence files");
  }
  const read = await readPrivateRegister(registerPath);
  const parsed = parseRegister(read.value);
  const bindingByEvidenceId = new Map<string, EvidenceBinding>();
  for (const candidate of parsed.register.candidates) {
    if (candidate.evidence.binding) {
      bindingByEvidenceId.set(candidate.evidence.binding.evidenceId, candidate.evidence.binding);
    }
  }
  const suppliedByEvidenceId = new Map<string, BoundVerifiedPublicPilotEvidence>();
  const suppliedFileIdentities = new Set<string>();
  const suppliedFileDigests = new Set<string>();
  for (let position = 0; position < evidencePaths.length; position += 1) {
    const evidenceNumber = position + 1;
    let verified: BoundVerifiedPublicPilotEvidence;
    try {
      verified = await verifyEvidence(evidencePaths[position] ?? "");
    } catch (error) {
      if (error instanceof PilotError) {
        throw new CohortRegisterError("Evidence file " + evidenceNumber + " failed verification: " + error.message, error.exitCode);
      }
      throw error;
    }
    if (
      suppliedByEvidenceId.has(verified.evidenceId) ||
      suppliedFileIdentities.has(verified.fileIdentity) ||
      suppliedFileDigests.has(verified.fileSha256)
    ) {
      throw new CohortRegisterError("Evidence file " + evidenceNumber + " duplicates another supplied evidence file");
    }
    const binding = bindingByEvidenceId.get(verified.evidenceId);
    if (!binding) {
      throw new CohortRegisterError("Evidence file " + evidenceNumber + " is not represented in the private register");
    }
    if (
      binding.fileSha256 !== verified.fileSha256 ||
      binding.evidenceSha256 !== verified.evidenceSha256 ||
      binding.schemaVersion !== verified.schemaVersion
    ) {
      throw new CohortRegisterError("Evidence file " + evidenceNumber + " does not match its registered binding");
    }
    suppliedByEvidenceId.set(verified.evidenceId, verified);
    suppliedFileIdentities.add(verified.fileIdentity);
    suppliedFileDigests.add(verified.fileSha256);
  }

  const duplicatePublishers = duplicateIncludedReferences(parsed.register.candidates, "publisherRef");
  const duplicateProjects = duplicateIncludedReferences(parsed.register.candidates, "projectRef");
  const auditedCandidates = parsed.register.candidates.map((candidate, index) =>
    auditCandidate(
      candidate,
      index + 1,
      parsed.register.asOfDate,
      candidate.evidence.binding
        ? (suppliedByEvidenceId.get(candidate.evidence.binding.evidenceId) ?? null)
        : null,
      duplicatePublishers,
      duplicateProjects,
    ),
  );
  const auditedByRef = new Map(auditedCandidates.map((entry) => [entry.candidate.candidateRef, entry]));
  const auditedDefects = parsed.register.defects.map((defect, index) =>
    auditDefect(defect, index + 1, auditedByRef, parsed.register.asOfDate),
  );
  const fullyQualified = auditedCandidates.filter((entry) => entry.fullyQualified);
  const thresholdMet =
    parsed.register.integritySha256 !== null &&
    fullyQualified.length >= 3 &&
    new Set(fullyQualified.map((entry) => entry.candidate.publisherRef)).size >= 3 &&
    new Set(fullyQualified.map((entry) => entry.candidate.projectRef)).size >= 3;
  const crossProjectDefects = parsed.register.defects.filter(
    (entry) => entry.status === "operator-recorded-cross-project-reproduction",
  ).length;
  const qualifiedCrossProjectDefects = auditedDefects.filter(
    (entry) =>
      entry.recordedStatus === "operator-recorded-cross-project-reproduction" &&
      entry.structuralStatus === "consistent" &&
      entry.qualifiedReproductionBindings >= 2,
  ).length;
  return {
    schemaVersion: 1,
    kind: "launchrig-private-cohort-register-audit",
    profile: "phase-2c-publisher-governance-v1",
    register: {
      fileSha256: read.fileSha256,
      contentSha256: parsed.contentSha256,
      revision: parsed.register.revision,
      integrityRecorded: parsed.register.integritySha256 !== null,
      privacyShapeValid: true,
      structuralConsistencyValid: true,
    },
    entries: auditedCandidates.map((entry) => entry.output),
    defects: auditedDefects,
    summary: {
      candidateRecords: parsed.register.candidates.length,
      interestRecorded: parsed.register.candidates.filter((entry) => entry.recruitment.status === "interest-recorded").length,
      activeConsentRecorded: parsed.register.candidates.filter((entry) => entry.consent.status === "operator-recorded-active").length,
      completedSessionsRecorded: parsed.register.candidates.filter((entry) => entry.session.status === "completed").length,
      sharingApprovedRecorded: parsed.register.candidates.filter(
        (entry) => entry.evidence.sharingStatus === "operator-recorded-approved",
      ).length,
      recordedIncludedCandidates: parsed.register.candidates.filter(
        (entry) => entry.countDecision.status === "operator-recorded-include",
      ).length,
      suppliedEvidenceFiles: evidencePaths.length,
      matchedEvidenceBindings: suppliedByEvidenceId.size,
      recomputedQualifiedV2Bindings: [...suppliedByEvidenceId.values()].filter(
        (entry) => entry.schemaVersion === 2 && entry.reportedTechnicalTargetsMet,
      ).length,
      recordedIncludedWithQualifiedV2: fullyQualified.length,
      distinctRecordedPublishersForQualifiedIncluded: new Set(
        fullyQualified.map((entry) => entry.candidate.publisherRef),
      ).size,
      distinctRecordedProjectsForQualifiedIncluded: new Set(
        fullyQualified.map((entry) => entry.candidate.projectRef),
      ).size,
      requiredPublisherProjects: 3,
      recordedGovernanceAndTechnicalThresholdMet: thresholdMet,
      defectRecords: parsed.register.defects.length,
      recordedCrossProjectDefectReviews: crossProjectDefects,
      recordedCrossProjectDefectReviewsWithQualifiedBindings: qualifiedCrossProjectDefects,
    },
    externalGrantGate: {
      status: "not-established",
      publisherIdentity: "not-established",
      publisherAuthority: "not-established",
      publisherConsent: "not-established",
      publisherIndependence: "not-established",
      confirmedDefectAcrossTwoProjects: "not-established",
      seekerAttestation: "not-established",
      publicRelease: "not-established",
    },
    grantReady: false,
    limitations: [...COHORT_REGISTER_LIMITATIONS],
  };
}
