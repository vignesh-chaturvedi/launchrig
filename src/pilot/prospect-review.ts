import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  privateFileIdentityMatches,
  type PrivateFileIdentity,
  SecureFileError,
  writeNewPrivateFileNoFollow,
} from "../security/file.js";
import { sha256Value } from "./store.js";

const MAX_REVIEW_INPUT_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REVIEWER_REF = new RegExp("^urn:launchrig:reviewer:" + UUID_V4.source.slice(1, -1) + "$");

export const PROSPECT_REVIEW_LABELS = [
  "operator-reviewed-consider-outreach",
  "operator-reviewed-defer",
  "operator-reviewed-do-not-contact",
] as const;

export const DRAFT_REVIEW_LABELS = [
  "operator-reviewed-needs-revision",
  "operator-reviewed-awaiting-separate-send-authorization",
  "operator-reviewed-do-not-send",
] as const;

export const PROSPECT_REVIEW_REASON_CODES = [
  "fit-check-boundary-reviewed",
  "source-review-incomplete",
  "route-review-incomplete",
  "draft-needs-revision",
  "timing-deferred",
  "relationship-review-incomplete",
  "safety-review-incomplete",
  "inappropriate-route",
  "explicit-contact-restriction",
  "inactive-target",
  "out-of-scope",
  "unacceptable-conflict",
  "unsafe-product-boundary",
] as const;

export const PROSPECT_REVIEW_FINDING_VALUES = {
  citedSource: ["reopened-and-fact-confirmed", "incomplete"],
  unobservedDetails: ["preserved-as-unknown", "incomplete"],
  contactRoute: ["appropriate", "inappropriate", "unresolved"],
  relationshipDisclosure: ["complete-or-not-applicable", "incomplete"],
  compensationDisclosure: ["complete-or-not-applicable", "incomplete"],
  messageScope: ["fit-check-only", "broader-request-present"],
  installationOrAccessRequest: ["absent", "present"],
  financialRisk: ["excluded", "present-or-unresolved"],
  biometricRisk: ["excluded", "present-or-unresolved"],
  credentialRisk: ["excluded", "present-or-unresolved"],
  deviceControlRisk: ["excluded", "present-or-unresolved"],
  locationRisk: ["excluded", "present-or-unresolved"],
  productionAccountRisk: ["excluded", "present-or-unresolved"],
  mainnetRisk: ["excluded", "present-or-unresolved"],
  valuableFundsRisk: ["excluded", "present-or-unresolved"],
} as const;

export const PROSPECT_REVIEW_LIMITATIONS = [
  "This record preserves an explicit operator assertion about exact private prospect and draft bytes. It does not authenticate the reviewer, publisher, project, source, contact route, or findings.",
  "The record performs no contact and grants no send authorization, candidate status, publisher interest, consent, project access, installation, device access, wallet action, or pilot execution.",
  "Any change to either exact input invalidates this review for the changed bytes and requires a new human review record.",
  "File ownership and mode checks do not prove ACL, backup, sync, process-list, shell-history, or cloud-storage privacy.",
  "Publisher identity, authority, consent, independence, external testing, Seeker evidence, confirmed defects, and grant readiness remain not established.",
  "The command does not detect duplicate or conflicting review records, and no record is implicitly the latest. Any later send decision must bind one exact review-file SHA-256 plus the unchanged prospect and draft SHA-256 values.",
] as const;

type ValueOf<T extends readonly string[]> = T[number];

export type ProspectReviewLabel = ValueOf<typeof PROSPECT_REVIEW_LABELS>;
export type DraftReviewLabel = ValueOf<typeof DRAFT_REVIEW_LABELS>;
export type ProspectReviewReasonCode = ValueOf<typeof PROSPECT_REVIEW_REASON_CODES>;
export type ProspectReviewFindingKey = keyof typeof PROSPECT_REVIEW_FINDING_VALUES;
export type ProspectReviewFindingValue<K extends ProspectReviewFindingKey> =
  ValueOf<(typeof PROSPECT_REVIEW_FINDING_VALUES)[K]>;

export interface ProspectReviewFindings {
  citedSource: ProspectReviewFindingValue<"citedSource">;
  unobservedDetails: ProspectReviewFindingValue<"unobservedDetails">;
  contactRoute: ProspectReviewFindingValue<"contactRoute">;
  relationshipDisclosure: ProspectReviewFindingValue<"relationshipDisclosure">;
  compensationDisclosure: ProspectReviewFindingValue<"compensationDisclosure">;
  messageScope: ProspectReviewFindingValue<"messageScope">;
  installationOrAccessRequest: ProspectReviewFindingValue<"installationOrAccessRequest">;
  financialRisk: ProspectReviewFindingValue<"financialRisk">;
  biometricRisk: ProspectReviewFindingValue<"biometricRisk">;
  credentialRisk: ProspectReviewFindingValue<"credentialRisk">;
  deviceControlRisk: ProspectReviewFindingValue<"deviceControlRisk">;
  locationRisk: ProspectReviewFindingValue<"locationRisk">;
  productionAccountRisk: ProspectReviewFindingValue<"productionAccountRisk">;
  mainnetRisk: ProspectReviewFindingValue<"mainnetRisk">;
  valuableFundsRisk: ProspectReviewFindingValue<"valuableFundsRisk">;
}

export interface RecordProspectReviewOptions {
  prospectPath: string;
  expectedProspectSha256: string;
  draftPath: string;
  expectedDraftSha256: string;
  reviewerRef: string;
  reviewedOn: string;
  prospectLabel: string;
  draftLabel: string;
  reasonCodes: readonly string[];
  findings: ProspectReviewFindings;
  humanReviewConfirmed: boolean;
  outputPath: string;
}

export interface PrivateProspectReviewV1 {
  schemaVersion: 1;
  kind: "launchrig-private-prospect-review";
  profile: "phase-2l-human-prospect-review-v1";
  privacyProfile: "opaque-reviewer-digests-labels-v1";
  reviewRef: string;
  reviewedOn: string;
  reviewerRef: string;
  claimStatus: "human-operator-recorded-unattested";
  humanReviewConfirmed: true;
  humanReviewerAuthenticated: false;
  prospect: {
    fileSha256: string;
    sizeBytes: number;
    label: ProspectReviewLabel;
  };
  draft: {
    fileSha256: string;
    sizeBytes: number;
    label: DraftReviewLabel;
  };
  reasonCodes: ProspectReviewReasonCode[];
  findings: ProspectReviewFindings;
  contact: "not-contacted";
  sendAuthorization: "not-authorized";
  lifecycle: "screening";
  candidateCreated: false;
  interestRecorded: false;
  projectModificationAuthorized: false;
  phoneAccessAuthorized: false;
  pilotStateChecked: false;
  deviceEnvironmentChecked: false;
  publisherIdentity: "not-established";
  publisherAuthority: "not-established";
  publisherConsent: "not-established";
  publisherIndependence: "not-established";
  externalGrantGate: "not-established";
  grantReady: false;
  limitations: string[];
  integritySha256: string;
}

export interface ProspectReviewResultV1 {
  schemaVersion: 1;
  kind: "launchrig-private-prospect-review-result";
  profile: "phase-2l-human-prospect-review-v1";
  status: "created";
  claimStatus: "human-operator-recorded-unattested";
  humanReviewConfirmed: true;
  humanReviewerAuthenticated: false;
  reviewFileSha256: string;
  reviewContentSha256: string;
  prospectFileSha256: string;
  draftFileSha256: string;
  prospectLabel: ProspectReviewLabel;
  draftLabel: DraftReviewLabel;
  contact: "not-contacted";
  sendAuthorization: "not-authorized";
  lifecycle: "screening";
  candidateCreated: false;
  interestRecorded: false;
  projectModificationAuthorized: false;
  phoneAccessAuthorized: false;
  pilotStateChecked: false;
  deviceEnvironmentChecked: false;
  publisherIdentity: "not-established";
  publisherAuthority: "not-established";
  publisherConsent: "not-established";
  publisherIndependence: "not-established";
  externalGrantGate: "not-established";
  grantReady: false;
  limitations: string[];
}

export class ProspectReviewError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 2 | 3 = 2,
  ) {
    super(message);
    this.name = "ProspectReviewError";
  }
}

export interface PrivateReviewInputSnapshot {
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
  sizeBytes: number;
  mode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  sha256: string;
  bytes: Buffer;
}

export interface RecordProspectReviewDependencies {
  capturePrivateInput?: typeof capturePrivateReviewInput;
  writePrivateFile?: typeof writeNewPrivateFileNoFollow;
  privateFileIdentityMatches?: typeof privateFileIdentityMatches;
  verifyWrittenReview?: typeof verifyWrittenProspectReview;
  randomUuid?: () => string;
  currentDate?: () => string;
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = path.normalize(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function inputMetadataIsPrivate(
  metadata: BigIntStats,
  currentUid: number | null,
): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.size > 0n &&
    metadata.size <= BigInt(MAX_REVIEW_INPUT_BYTES) &&
    metadata.nlink === 1n &&
    (currentUid === null || metadata.uid === BigInt(currentUid)) &&
    (process.platform === "win32" || (metadata.mode & 0o777n) === 0o600n)
  );
}

function sameInputMetadata(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink &&
    left.uid === right.uid
  );
}

export async function capturePrivateReviewInput(
  inputPath: string,
  label: string,
): Promise<PrivateReviewInputSnapshot> {
  if (!validPath(inputPath) || !path.isAbsolute(inputPath)) {
    throw new ProspectReviewError(label + " path must be a valid absolute path");
  }
  const requestedPath = path.resolve(inputPath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requestedPath);
  } catch {
    throw new ProspectReviewError(label + " cannot be read safely", 3);
  }
  if (!sameCanonicalPath(canonicalPath, requestedPath)) {
    throw new ProspectReviewError(label + " path contains a symbolic-link component", 3);
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    const before = await lstat(canonicalPath, { bigint: true });
    if (!inputMetadataIsPrivate(before, currentUid)) throw new Error("unsafe private input");
    handle = await open(
      canonicalPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
    );
    const opened = await handle.stat({ bigint: true });
    if (!inputMetadataIsPrivate(opened, currentUid) || !sameInputMetadata(before, opened)) {
      throw new Error("unsafe private input");
    }

    const expectedSize = Number(opened.size);
    const buffer = Buffer.alloc(expectedSize + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(canonicalPath, { bigint: true });
    if (
      bytesRead !== expectedSize ||
      !inputMetadataIsPrivate(after, currentUid) ||
      !inputMetadataIsPrivate(afterPath, currentUid) ||
      !sameInputMetadata(opened, after) ||
      !sameInputMetadata(opened, afterPath)
    ) {
      throw new Error("private input changed while reading");
    }

    const bytes = Buffer.from(buffer.subarray(0, expectedSize));
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ProspectReviewError(label + " must use valid UTF-8");
    }
    if (/\u0000/.test(source)) throw new ProspectReviewError(label + " must use valid text content");
    return {
      canonicalPath,
      dev: opened.dev,
      ino: opened.ino,
      sizeBytes: expectedSize,
      mode: opened.mode,
      mtimeNs: opened.mtimeNs,
      ctimeNs: opened.ctimeNs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  } catch (error) {
    if (error instanceof ProspectReviewError) throw error;
    throw new ProspectReviewError(label + " cannot be read safely", 3);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function inputSnapshotMatches(
  left: PrivateReviewInputSnapshot,
  right: PrivateReviewInputSnapshot,
): boolean {
  return (
    sameCanonicalPath(left.canonicalPath, right.canonicalPath) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.sizeBytes === right.sizeBytes &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.sha256 === right.sha256 &&
    left.bytes.equals(right.bytes)
  );
}

function strictDate(value: unknown, currentDate: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ProspectReviewError("Prospect review date is invalid");
  }
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ProspectReviewError("Prospect review date is invalid");
  }
  if (value > currentDate) throw new ProspectReviewError("Prospect review date cannot be in the future");
  return value;
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ProspectReviewError(label + " is invalid");
  }
  return value as T[number];
}

function validateFindings(value: unknown): ProspectReviewFindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProspectReviewError("Prospect review findings are invalid");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = Object.keys(PROSPECT_REVIEW_FINDING_VALUES) as ProspectReviewFindingKey[];
  const actualKeys = Object.keys(record);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => !expectedKeys.includes(key as ProspectReviewFindingKey))
  ) {
    throw new ProspectReviewError("Prospect review findings must contain every fixed finding exactly once");
  }
  const result = {} as Record<ProspectReviewFindingKey, string>;
  for (const key of expectedKeys) {
    const candidate = record[key];
    const allowed = PROSPECT_REVIEW_FINDING_VALUES[key] as readonly string[];
    if (typeof candidate !== "string" || !allowed.includes(candidate)) {
      throw new ProspectReviewError("Prospect review finding " + key + " is invalid");
    }
    result[key] = candidate;
  }
  return result as unknown as ProspectReviewFindings;
}

function validateReasonCodes(value: unknown): ProspectReviewReasonCode[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > PROSPECT_REVIEW_REASON_CODES.length) {
    throw new ProspectReviewError("Prospect review reason codes are invalid");
  }
  const supplied = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== "string" ||
      !(PROSPECT_REVIEW_REASON_CODES as readonly string[]).includes(candidate) ||
      supplied.has(candidate)
    ) {
      throw new ProspectReviewError("Prospect review reason codes are invalid");
    }
    supplied.add(candidate);
  }
  return PROSPECT_REVIEW_REASON_CODES.filter((code) => supplied.has(code));
}

const RISK_KEYS = [
  "financialRisk",
  "biometricRisk",
  "credentialRisk",
  "deviceControlRisk",
  "locationRisk",
  "productionAccountRisk",
  "mainnetRisk",
  "valuableFundsRisk",
] as const;

function allProspectFindingsPositive(findings: ProspectReviewFindings): boolean {
  return (
    findings.citedSource === "reopened-and-fact-confirmed" &&
    findings.unobservedDetails === "preserved-as-unknown" &&
    findings.contactRoute === "appropriate" &&
    findings.relationshipDisclosure === "complete-or-not-applicable" &&
    findings.compensationDisclosure === "complete-or-not-applicable" &&
    RISK_KEYS.every((key) => findings[key] === "excluded")
  );
}

function allFindingsPositive(findings: ProspectReviewFindings): boolean {
  return (
    allProspectFindingsPositive(findings) &&
    findings.messageScope === "fit-check-only" &&
    findings.installationOrAccessRequest === "absent"
  );
}

function reasonSetEquals(
  reasonCodes: readonly ProspectReviewReasonCode[],
  expected: readonly ProspectReviewReasonCode[],
): boolean {
  return reasonCodes.length === expected.length && expected.every((code) => reasonCodes.includes(code));
}

function assertDecisionConsistency(
  prospectLabel: ProspectReviewLabel,
  draftLabel: DraftReviewLabel,
  reasonCodes: readonly ProspectReviewReasonCode[],
  findings: ProspectReviewFindings,
): void {
  if (prospectLabel === "operator-reviewed-consider-outreach") {
    if (!allProspectFindingsPositive(findings)) {
      throw new ProspectReviewError("Consider-outreach requires every prospect safety finding to be complete");
    }
    if (draftLabel === "operator-reviewed-awaiting-separate-send-authorization") {
      if (!allFindingsPositive(findings) || !reasonSetEquals(reasonCodes, ["fit-check-boundary-reviewed"])) {
        throw new ProspectReviewError(
          "Awaiting separate send authorization requires all positive findings and only fit-check-boundary-reviewed",
        );
      }
      return;
    }
    if (
      draftLabel !== "operator-reviewed-needs-revision" ||
      !reasonSetEquals(reasonCodes, ["draft-needs-revision"])
    ) {
      throw new ProspectReviewError(
        "Consider-outreach requires a reviewed draft that awaits separate authorization or needs revision",
      );
    }
    return;
  }

  if (draftLabel !== "operator-reviewed-do-not-send") {
    throw new ProspectReviewError("Deferred and do-not-contact prospects require a do-not-send draft label");
  }

  if (prospectLabel === "operator-reviewed-defer") {
    const allowed = new Set<ProspectReviewReasonCode>([
      "source-review-incomplete",
      "route-review-incomplete",
      "draft-needs-revision",
      "timing-deferred",
      "relationship-review-incomplete",
      "safety-review-incomplete",
    ]);
    if (reasonCodes.some((code) => !allowed.has(code))) {
      throw new ProspectReviewError("Deferred prospect reason codes are inconsistent with the review label");
    }
    if (findings.contactRoute === "inappropriate") {
      throw new ProspectReviewError("An inappropriate contact route requires a do-not-contact prospect label");
    }
    const sourceIncomplete = findings.citedSource === "incomplete" || findings.unobservedDetails === "incomplete";
    if (reasonCodes.includes("source-review-incomplete") !== sourceIncomplete) {
      throw new ProspectReviewError("Source-review reason and source findings must match");
    }
    const routeIncomplete = findings.contactRoute === "unresolved";
    if (reasonCodes.includes("route-review-incomplete") !== routeIncomplete) {
      throw new ProspectReviewError("Route-review reason and route finding must match");
    }
    const relationshipIncomplete =
      findings.relationshipDisclosure === "incomplete" || findings.compensationDisclosure === "incomplete";
    if (reasonCodes.includes("relationship-review-incomplete") !== relationshipIncomplete) {
      throw new ProspectReviewError("Relationship-review reason and disclosure findings must match");
    }
    const safetyIncomplete =
      RISK_KEYS.some((key) => findings[key] === "present-or-unresolved") ||
      findings.messageScope === "broader-request-present" ||
      findings.installationOrAccessRequest === "present";
    if (reasonCodes.includes("safety-review-incomplete") !== safetyIncomplete) {
      throw new ProspectReviewError("Safety-review reason and safety findings must match");
    }
    if (
      (findings.messageScope === "broader-request-present" || findings.installationOrAccessRequest === "present") &&
      !reasonCodes.includes("draft-needs-revision") &&
      !reasonCodes.includes("safety-review-incomplete")
    ) {
      throw new ProspectReviewError("Unsafe draft findings require a revision or safety reason code");
    }
    return;
  }

  const terminalReasons = new Set<ProspectReviewReasonCode>([
    "inappropriate-route",
    "explicit-contact-restriction",
    "inactive-target",
    "out-of-scope",
    "unacceptable-conflict",
    "unsafe-product-boundary",
  ]);
  if (reasonCodes.some((code) => !terminalReasons.has(code))) {
    throw new ProspectReviewError("Do-not-contact reason codes are inconsistent with the review label");
  }
  if (reasonCodes.includes("inappropriate-route") && findings.contactRoute !== "inappropriate") {
    throw new ProspectReviewError("The inappropriate-route reason requires an inappropriate route finding");
  }
  if (
    reasonCodes.includes("unsafe-product-boundary") &&
    RISK_KEYS.every((key) => findings[key] === "excluded") &&
    findings.messageScope !== "broader-request-present" &&
    findings.installationOrAccessRequest !== "present"
  ) {
    throw new ProspectReviewError("The unsafe-product-boundary reason requires a matching unsafe finding");
  }
}

function reviewRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProspectReviewError(label + " is invalid");
  }
  return value as Record<string, unknown>;
}

function assertExactReviewKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) {
    throw new ProspectReviewError(label + " contains unsupported or missing fields");
  }
}

function storedReviewDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ProspectReviewError(label + " is invalid");
  }
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ProspectReviewError(label + " is invalid");
  }
  return value;
}

function reviewSize(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_REVIEW_INPUT_BYTES) {
    throw new ProspectReviewError(label + " is invalid");
  }
  return value as number;
}

function reviewHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ProspectReviewError(label + " is invalid");
  }
  return value;
}

export function parsePrivateProspectReviewV1(value: unknown): PrivateProspectReviewV1 {
  const review = reviewRecord(value, "Private prospect review");
  assertExactReviewKeys(
    review,
    [
      "schemaVersion",
      "kind",
      "profile",
      "privacyProfile",
      "reviewRef",
      "reviewedOn",
      "reviewerRef",
      "claimStatus",
      "humanReviewConfirmed",
      "humanReviewerAuthenticated",
      "prospect",
      "draft",
      "reasonCodes",
      "findings",
      "contact",
      "sendAuthorization",
      "lifecycle",
      "candidateCreated",
      "interestRecorded",
      "projectModificationAuthorized",
      "phoneAccessAuthorized",
      "pilotStateChecked",
      "deviceEnvironmentChecked",
      "publisherIdentity",
      "publisherAuthority",
      "publisherConsent",
      "publisherIndependence",
      "externalGrantGate",
      "grantReady",
      "limitations",
      "integritySha256",
    ],
    "Private prospect review",
  );
  if (
    review.schemaVersion !== 1 ||
    review.kind !== "launchrig-private-prospect-review" ||
    review.profile !== "phase-2l-human-prospect-review-v1" ||
    review.privacyProfile !== "opaque-reviewer-digests-labels-v1" ||
    review.claimStatus !== "human-operator-recorded-unattested" ||
    review.humanReviewConfirmed !== true ||
    review.humanReviewerAuthenticated !== false ||
    review.contact !== "not-contacted" ||
    review.sendAuthorization !== "not-authorized" ||
    review.lifecycle !== "screening" ||
    review.candidateCreated !== false ||
    review.interestRecorded !== false ||
    review.projectModificationAuthorized !== false ||
    review.phoneAccessAuthorized !== false ||
    review.pilotStateChecked !== false ||
    review.deviceEnvironmentChecked !== false ||
    review.publisherIdentity !== "not-established" ||
    review.publisherAuthority !== "not-established" ||
    review.publisherConsent !== "not-established" ||
    review.publisherIndependence !== "not-established" ||
    review.externalGrantGate !== "not-established" ||
    review.grantReady !== false
  ) {
    throw new ProspectReviewError("Private prospect review contract is invalid");
  }
  if (typeof review.reviewRef !== "string" || !new RegExp(
    "^urn:launchrig:prospect-review:" + UUID_V4.source.slice(1, -1) + "$",
  ).test(review.reviewRef)) {
    throw new ProspectReviewError("Private prospect review reference is invalid");
  }
  if (typeof review.reviewerRef !== "string" || !REVIEWER_REF.test(review.reviewerRef)) {
    throw new ProspectReviewError("Private prospect reviewer reference is invalid");
  }
  storedReviewDate(review.reviewedOn, "Private prospect review date");

  const prospect = reviewRecord(review.prospect, "Private prospect review prospect binding");
  const draft = reviewRecord(review.draft, "Private prospect review draft binding");
  assertExactReviewKeys(prospect, ["fileSha256", "sizeBytes", "label"], "Private prospect review prospect binding");
  assertExactReviewKeys(draft, ["fileSha256", "sizeBytes", "label"], "Private prospect review draft binding");
  reviewHash(prospect.fileSha256, "Private prospect review prospect hash");
  reviewHash(draft.fileSha256, "Private prospect review draft hash");
  reviewSize(prospect.sizeBytes, "Private prospect review prospect size");
  reviewSize(draft.sizeBytes, "Private prospect review draft size");
  const prospectLabel = enumValue(prospect.label, PROSPECT_REVIEW_LABELS, "Private prospect review prospect label");
  const draftLabel = enumValue(draft.label, DRAFT_REVIEW_LABELS, "Private prospect review draft label");
  const reasonCodes = validateReasonCodes(review.reasonCodes);
  if (JSON.stringify(reasonCodes) !== JSON.stringify(review.reasonCodes)) {
    throw new ProspectReviewError("Private prospect review reason codes are not canonical");
  }
  const findings = validateFindings(review.findings);
  assertDecisionConsistency(prospectLabel, draftLabel, reasonCodes, findings);
  if (
    !Array.isArray(review.limitations) ||
    JSON.stringify(review.limitations) !== JSON.stringify(PROSPECT_REVIEW_LIMITATIONS)
  ) {
    throw new ProspectReviewError("Private prospect review limitations are invalid");
  }
  reviewHash(review.integritySha256, "Private prospect review integrity hash");
  const { integritySha256: _integritySha256, ...core } = review;
  if (review.integritySha256 !== sha256Value(core)) {
    throw new ProspectReviewError("Private prospect review integrity check failed");
  }
  return review as unknown as PrivateProspectReviewV1;
}

function currentUtcDate(): string {
  const now = new Date();
  if (!Number.isFinite(now.valueOf())) throw new ProspectReviewError("Current date is invalid", 3);
  return now.toISOString().slice(0, 10);
}

function typedReviewRef(uuidFactory: () => string): string {
  const value = uuidFactory();
  if (!UUID_V4.test(value)) throw new ProspectReviewError("Secure review reference cannot be generated", 3);
  return "urn:launchrig:prospect-review:" + value;
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))
  );
}

async function activeGitWorktreeRoot(startPath: string): Promise<string | null> {
  let current = await realpath(startPath);
  while (true) {
    try {
      const metadata = await lstat(path.join(current, ".git"));
      if (metadata.isSymbolicLink()) throw new ProspectReviewError("Active Git worktree metadata is unsafe", 3);
      if (metadata.isDirectory() || metadata.isFile()) return current;
      throw new ProspectReviewError("Active Git worktree metadata is unsafe", 3);
    } catch (error) {
      if (error instanceof ProspectReviewError) throw error;
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== "ENOENT") throw new ProspectReviewError("Active Git worktree cannot be inspected safely", 3);
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function assertPrivateOutputPath(outputPath: string): Promise<void> {
  if (!validPath(outputPath) || !path.isAbsolute(outputPath)) {
    throw new ProspectReviewError("Private prospect review output must be a valid absolute path");
  }
  const requestedParent = path.dirname(path.resolve(outputPath));
  let outputParent: string;
  try {
    outputParent = await realpath(requestedParent);
  } catch {
    throw new ProspectReviewError("Private prospect review output parent cannot be resolved safely", 3);
  }
  if (!sameCanonicalPath(requestedParent, outputParent)) {
    throw new ProspectReviewError("Private prospect review output parent contains a symbolic-link component", 3);
  }
  const worktreeRoot = await activeGitWorktreeRoot(outputParent);
  const candidate = path.join(outputParent, path.basename(path.resolve(outputPath)));
  if (worktreeRoot && isContained(worktreeRoot, candidate)) {
    throw new ProspectReviewError("Private prospect review output must be outside the active Git worktree");
  }
  const metadata = await lstat(outputParent, { bigint: true }).catch(() => undefined);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !metadata ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (currentUid !== null && metadata.uid !== BigInt(currentUid)) ||
    (process.platform !== "win32" && (metadata.mode & 0o077n) !== 0n)
  ) {
    throw new ProspectReviewError("Private prospect review output parent must be owner-controlled and private", 3);
  }
}

async function verifyWrittenProspectReview(
  outputPath: string,
  expectedBytes: Buffer,
  expectedReview: PrivateProspectReviewV1,
): Promise<void> {
  const snapshot = await capturePrivateReviewInput(outputPath, "Private prospect review output");
  if (!snapshot.bytes.equals(expectedBytes)) throw new Error("written review bytes changed");
  const parsed = JSON.parse(snapshot.bytes.toString("utf8")) as unknown;
  if (JSON.stringify(parsed) !== JSON.stringify(expectedReview)) throw new Error("written review content changed");
  const { integritySha256: _integrity, ...core } = expectedReview;
  if (expectedReview.integritySha256 !== sha256Value(core)) throw new Error("written review integrity changed");
}

function assertStableInput(
  initial: PrivateReviewInputSnapshot,
  current: PrivateReviewInputSnapshot,
  label: string,
): void {
  if (!inputSnapshotMatches(initial, current)) {
    throw new ProspectReviewError(label + " changed while the review record was being prepared", 3);
  }
}

export async function recordProspectReview(
  options: RecordProspectReviewOptions,
  dependencies: RecordProspectReviewDependencies = {},
): Promise<ProspectReviewResultV1> {
  if (options.humanReviewConfirmed !== true) {
    throw new ProspectReviewError("Explicit human review confirmation is required");
  }
  if (!SHA256.test(options.expectedProspectSha256) || !SHA256.test(options.expectedDraftSha256)) {
    throw new ProspectReviewError("Expected prospect and draft SHA-256 values are required");
  }
  if (typeof options.reviewerRef !== "string" || !REVIEWER_REF.test(options.reviewerRef)) {
    throw new ProspectReviewError("Prospect review reviewer reference is invalid");
  }
  const reviewedOn = strictDate(options.reviewedOn, (dependencies.currentDate ?? currentUtcDate)());
  const prospectLabel = enumValue(options.prospectLabel, PROSPECT_REVIEW_LABELS, "Prospect review label");
  const draftLabel = enumValue(options.draftLabel, DRAFT_REVIEW_LABELS, "Draft review label");
  const reasonCodes = validateReasonCodes(options.reasonCodes);
  const findings = validateFindings(options.findings);
  assertDecisionConsistency(prospectLabel, draftLabel, reasonCodes, findings);
  await assertPrivateOutputPath(options.outputPath);

  const capture = dependencies.capturePrivateInput ?? capturePrivateReviewInput;
  const [prospect, draft] = await Promise.all([
    capture(options.prospectPath, "Private prospect input"),
    capture(options.draftPath, "Private draft input"),
  ]);
  if (
    prospect.dev === draft.dev &&
    prospect.ino === draft.ino ||
    prospect.sha256 === draft.sha256
  ) {
    throw new ProspectReviewError("Prospect and draft inputs must be distinct private files with distinct bytes");
  }
  if (
    prospect.sha256 !== options.expectedProspectSha256 ||
    draft.sha256 !== options.expectedDraftSha256
  ) {
    throw new ProspectReviewError("Prospect or draft input does not match its explicitly confirmed SHA-256");
  }
  const resolvedOutput = path.resolve(options.outputPath);
  if (
    sameCanonicalPath(prospect.canonicalPath, resolvedOutput) ||
    sameCanonicalPath(draft.canonicalPath, resolvedOutput)
  ) {
    throw new ProspectReviewError("Private prospect review output must be distinct from both inputs");
  }

  const reviewCore = {
    schemaVersion: 1 as const,
    kind: "launchrig-private-prospect-review" as const,
    profile: "phase-2l-human-prospect-review-v1" as const,
    privacyProfile: "opaque-reviewer-digests-labels-v1" as const,
    reviewRef: typedReviewRef(dependencies.randomUuid ?? randomUUID),
    reviewedOn,
    reviewerRef: options.reviewerRef,
    claimStatus: "human-operator-recorded-unattested" as const,
    humanReviewConfirmed: true as const,
    humanReviewerAuthenticated: false as const,
    prospect: {
      fileSha256: prospect.sha256,
      sizeBytes: prospect.sizeBytes,
      label: prospectLabel,
    },
    draft: {
      fileSha256: draft.sha256,
      sizeBytes: draft.sizeBytes,
      label: draftLabel,
    },
    reasonCodes,
    findings,
    contact: "not-contacted" as const,
    sendAuthorization: "not-authorized" as const,
    lifecycle: "screening" as const,
    candidateCreated: false as const,
    interestRecorded: false as const,
    projectModificationAuthorized: false as const,
    phoneAccessAuthorized: false as const,
    pilotStateChecked: false as const,
    deviceEnvironmentChecked: false as const,
    publisherIdentity: "not-established" as const,
    publisherAuthority: "not-established" as const,
    publisherConsent: "not-established" as const,
    publisherIndependence: "not-established" as const,
    externalGrantGate: "not-established" as const,
    grantReady: false as const,
    limitations: [...PROSPECT_REVIEW_LIMITATIONS],
  };
  const review: PrivateProspectReviewV1 = {
    ...reviewCore,
    integritySha256: sha256Value(reviewCore),
  };
  const bytes = Buffer.from(JSON.stringify(review, null, 2) + "\n", "utf8");

  const [prospectBeforeWrite, draftBeforeWrite] = await Promise.all([
    capture(options.prospectPath, "Private prospect input"),
    capture(options.draftPath, "Private draft input"),
  ]);
  assertStableInput(prospect, prospectBeforeWrite, "Private prospect input");
  assertStableInput(draft, draftBeforeWrite, "Private draft input");

  let writtenIdentity: PrivateFileIdentity;
  try {
    writtenIdentity = await (dependencies.writePrivateFile ?? writeNewPrivateFileNoFollow)(
      options.outputPath,
      bytes,
    );
  } catch (error) {
    if (error instanceof SecureFileError && error.reason === "exists") {
      throw new ProspectReviewError("Private prospect review output already exists");
    }
    throw new ProspectReviewError(
      "Private prospect review output cannot be written safely; a mode-600 output may remain for manual inspection",
      3,
    );
  }

  try {
    const [prospectAfterWrite, draftAfterWrite] = await Promise.all([
      capture(options.prospectPath, "Private prospect input"),
      capture(options.draftPath, "Private draft input"),
    ]);
    assertStableInput(prospect, prospectAfterWrite, "Private prospect input");
    assertStableInput(draft, draftAfterWrite, "Private draft input");
    await (dependencies.verifyWrittenReview ?? verifyWrittenProspectReview)(
      writtenIdentity.canonicalPath,
      bytes,
      review,
    );
    if (!(await (dependencies.privateFileIdentityMatches ?? privateFileIdentityMatches)(writtenIdentity))) {
      throw new Error("written review identity changed");
    }
  } catch {
    throw new ProspectReviewError(
      "Private prospect review output failed final verification; a mode-600 output may remain for manual inspection",
      3,
    );
  }

  return {
    schemaVersion: 1,
    kind: "launchrig-private-prospect-review-result",
    profile: "phase-2l-human-prospect-review-v1",
    status: "created",
    claimStatus: "human-operator-recorded-unattested",
    humanReviewConfirmed: true,
    humanReviewerAuthenticated: false,
    reviewFileSha256: writtenIdentity.sha256,
    reviewContentSha256: review.integritySha256,
    prospectFileSha256: prospect.sha256,
    draftFileSha256: draft.sha256,
    prospectLabel,
    draftLabel,
    contact: "not-contacted",
    sendAuthorization: "not-authorized",
    lifecycle: "screening",
    candidateCreated: false,
    interestRecorded: false,
    projectModificationAuthorized: false,
    phoneAccessAuthorized: false,
    pilotStateChecked: false,
    deviceEnvironmentChecked: false,
    publisherIdentity: "not-established",
    publisherAuthority: "not-established",
    publisherConsent: "not-established",
    publisherIndependence: "not-established",
    externalGrantGate: "not-established",
    grantReady: false,
    limitations: [...PROSPECT_REVIEW_LIMITATIONS],
  };
}
