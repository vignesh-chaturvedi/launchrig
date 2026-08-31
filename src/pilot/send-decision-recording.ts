import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import {
  privateFileIdentityMatches,
  type PrivateFileIdentity,
  SecureFileError,
  writeNewPrivateFileNoFollow,
} from "../security/file.js";
import {
  capturePrivateReviewInput,
  parsePrivateProspectReviewV1,
  type PrivateProspectReviewV1,
  type PrivateReviewInputSnapshot,
  ProspectReviewError,
} from "./prospect-review.js";
import {
  parsePrivateSendDecisionRequestV1,
  type PrivateSendDecisionRequestV1,
  SendDecisionPreparationError,
} from "./send-decision-preparation.js";
import { sha256Value } from "./store.js";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REVIEWER_REF = new RegExp("^urn:launchrig:reviewer:" + UUID_V4.source.slice(1, -1) + "$");

export const HUMAN_SEND_DECISIONS = [
  "authorize-exact-reviewed-draft",
  "require-revision",
  "defer",
  "do-not-send",
] as const;

export const HUMAN_SEND_DECISION_REASON_CODES = [
  "exact-fit-check-send-authorized",
  "draft-revision-required",
  "timing-deferred",
  "source-recheck-incomplete",
  "route-recheck-incomplete",
  "inappropriate-route",
  "relationship-disclosure-incomplete",
  "compensation-disclosure-incomplete",
  "safety-recheck-incomplete",
  "explicit-contact-restriction",
  "operator-do-not-send",
] as const;

export const SOURCE_RECHECK_VALUES = [
  "reopened-and-fact-confirmed",
  "incomplete-or-stale",
] as const;

export const ROUTE_RECHECK_VALUES = [
  "appropriate",
  "inappropriate",
  "unresolved",
] as const;

export const DISCLOSURE_RECHECK_VALUES = [
  "complete-or-not-applicable",
  "incomplete",
] as const;

export const SAFETY_RECHECK_VALUES = [
  "fit-check-only-boundaries-confirmed",
  "incomplete-or-unsafe",
] as const;

export const HUMAN_SEND_DECISION_LIMITATIONS = [
  "This private record binds one human operator decision to exact request, review, prospect, and draft bytes. It does not authenticate the operator, authorizer, reviewer, publisher, source, route, disclosures, or safety assertions.",
  "A positive decision authorizes only one manual send of the exact reviewed draft before the recorded expiry. It does not automate, perform, or prove contact or dispatch.",
  "The no-additional-related-review confirmation is an unattested human assertion. Any changed input or newly discovered related review invalidates the decision and requires a new review, request, and decision.",
  "Source, route, relationship disclosure, compensation disclosure, and safety rechecks are human assertions recorded at decision time and are not independently verified.",
  "This decision does not establish delivery, reply, interest, candidacy, project permission, phone access, pilot state, device state, publisher identity, authority, consent, or independence.",
  "File ownership and mode checks do not prove ACL, backup, sync, process-list, shell-history, or cloud-storage privacy.",
  "External testing, confirmed defects, external grant gates, and grant readiness remain not established.",
] as const;

export type HumanSendDecision = typeof HUMAN_SEND_DECISIONS[number];
export type HumanSendDecisionReasonCode = typeof HUMAN_SEND_DECISION_REASON_CODES[number];
export type SourceRecheck = typeof SOURCE_RECHECK_VALUES[number];
export type RouteRecheck = typeof ROUTE_RECHECK_VALUES[number];
export type DisclosureRecheck = typeof DISCLOSURE_RECHECK_VALUES[number];
export type SafetyRecheck = typeof SAFETY_RECHECK_VALUES[number];

type SendAuthorization =
  | "authorized-for-one-exact-manual-fit-check-send"
  | "not-authorized";
type AuthorizationScope = "one-manual-send-of-exact-reviewed-draft" | "none";

export interface RecordHumanSendDecisionOptions {
  requestPath: string;
  expectedRequestSha256: string;
  reviewPath: string;
  expectedReviewSha256: string;
  prospectPath: string;
  expectedProspectSha256: string;
  draftPath: string;
  expectedDraftSha256: string;
  authorizerRef: string;
  decidedOn: string;
  decision: HumanSendDecision | string;
  reasonCodes: readonly string[];
  sourceRecheck: SourceRecheck | string;
  routeRecheck: RouteRecheck | string;
  relationshipDisclosureRecheck: DisclosureRecheck | string;
  compensationDisclosureRecheck: DisclosureRecheck | string;
  safetyRecheck: SafetyRecheck | string;
  authorizationExpiresOn?: string | null;
  humanSendDecisionConfirmed: boolean;
  outputPath: string;
}

export interface PrivateHumanSendDecisionV1 {
  schemaVersion: 1;
  kind: "launchrig-private-human-send-decision";
  profile: "phase-2n-human-send-decision-v1";
  privacyProfile: "opaque-authorizer-digests-decision-v1";
  decisionRef: string;
  decidedOn: string;
  authorizerRef: string;
  claimStatus: "human-operator-recorded-unattested";
  humanSendDecisionConfirmed: true;
  humanNoAdditionalRelatedReviewConfirmed: true;
  humanAuthorizerAuthenticated: false;
  reviewSetCompleteness: "operator-asserted-unattested";
  conflictStatus: "none-detected-in-operator-supplied-set";
  latestStatus: "not-established";
  reviewSetCount: 1;
  request: {
    fileSha256: string;
    contentSha256: string;
    preparedOn: string;
    reviewSetSha256: string;
  };
  review: {
    fileSha256: string;
    contentSha256: string;
    reviewRef: string;
    reviewedOn: string;
  };
  prospect: {
    fileSha256: string;
    sizeBytes: number;
  };
  draft: {
    fileSha256: string;
    sizeBytes: number;
  };
  decision: HumanSendDecision;
  reasonCodes: HumanSendDecisionReasonCode[];
  sourceRecheck: SourceRecheck;
  routeRecheck: RouteRecheck;
  relationshipDisclosureRecheck: DisclosureRecheck;
  compensationDisclosureRecheck: DisclosureRecheck;
  safetyRecheck: SafetyRecheck;
  authorizationExpiresOn: string | null;
  sendAuthorization: SendAuthorization;
  authorizationScope: AuthorizationScope;
  contact: "not-contacted";
  messageDispatched: false;
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

export interface HumanSendDecisionResultV1 {
  schemaVersion: 1;
  kind: "launchrig-private-human-send-decision-result";
  profile: "phase-2n-human-send-decision-v1";
  status: "created";
  claimStatus: "human-operator-recorded-unattested";
  humanSendDecisionConfirmed: true;
  humanNoAdditionalRelatedReviewConfirmed: true;
  humanAuthorizerAuthenticated: false;
  reviewSetCompleteness: "operator-asserted-unattested";
  conflictStatus: "none-detected-in-operator-supplied-set";
  latestStatus: "not-established";
  reviewSetCount: 1;
  decisionFileSha256: string;
  decisionContentSha256: string;
  requestFileSha256: string;
  requestContentSha256: string;
  reviewFileSha256: string;
  reviewContentSha256: string;
  prospectFileSha256: string;
  draftFileSha256: string;
  reviewSetSha256: string;
  decision: HumanSendDecision;
  reasonCodes: HumanSendDecisionReasonCode[];
  sourceRecheck: SourceRecheck;
  routeRecheck: RouteRecheck;
  relationshipDisclosureRecheck: DisclosureRecheck;
  compensationDisclosureRecheck: DisclosureRecheck;
  safetyRecheck: SafetyRecheck;
  authorizationExpiresOn: string | null;
  sendAuthorization: SendAuthorization;
  authorizationScope: AuthorizationScope;
  contact: "not-contacted";
  messageDispatched: false;
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

export class HumanSendDecisionError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 2 | 3 = 2,
  ) {
    super(message);
    this.name = "HumanSendDecisionError";
  }
}

export interface RecordHumanSendDecisionDependencies {
  capturePrivateInput?: typeof capturePrivateReviewInput;
  writePrivateFile?: typeof writeNewPrivateFileNoFollow;
  privateFileIdentityMatches?: typeof privateFileIdentityMatches;
  verifyWrittenDecision?: typeof verifyWrittenHumanSendDecision;
  currentDate?: () => string;
  randomUuid?: () => string;
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

function sameCanonicalPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = path.normalize(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))
  );
}

function strictHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new HumanSendDecisionError(label + " must be an explicit lowercase SHA-256 value");
  }
  return value;
}

function currentUtcDate(): string {
  const now = new Date();
  if (!Number.isFinite(now.valueOf())) throw new HumanSendDecisionError("Current date is invalid", 3);
  return now.toISOString().slice(0, 10);
}

function validCalendarDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HumanSendDecisionError(label + " is invalid");
  }
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HumanSendDecisionError(label + " is invalid");
  }
  return value;
}

function strictDecisionDate(value: unknown, today: string): string {
  const decidedOn = validCalendarDate(value, "Human send decision date");
  if (decidedOn > today) throw new HumanSendDecisionError("Human send decision date cannot be in the future");
  return decidedOn;
}

function nextCalendarDate(value: string): string {
  const parsed = new Date(value + "T00:00:00.000Z");
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value as T[number])) {
    throw new HumanSendDecisionError(label + " is invalid");
  }
  return value as T[number];
}

function validateReasonCodes(value: unknown): HumanSendDecisionReasonCode[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > HUMAN_SEND_DECISION_REASON_CODES.length) {
    throw new HumanSendDecisionError("Human send decision reason codes are invalid");
  }
  const seen = new Set<string>();
  const codes = value.map((entry) => {
    const code = enumValue(entry, HUMAN_SEND_DECISION_REASON_CODES, "Human send decision reason code");
    if (seen.has(code)) throw new HumanSendDecisionError("Human send decision reason codes must be unique");
    seen.add(code);
    return code;
  });
  const canonical = HUMAN_SEND_DECISION_REASON_CODES.filter((code) => seen.has(code));
  if (JSON.stringify(codes) !== JSON.stringify(canonical)) {
    throw new HumanSendDecisionError("Human send decision reason codes must use canonical order");
  }
  return codes;
}

function expectReason(
  reasonCodes: readonly HumanSendDecisionReasonCode[],
  reason: HumanSendDecisionReasonCode,
  expected: boolean,
  label: string,
): void {
  if (reasonCodes.includes(reason) !== expected) {
    throw new HumanSendDecisionError(label + " reason and recheck must match");
  }
}

function validateDecisionMatrix(
  decision: HumanSendDecision,
  reasonCodes: readonly HumanSendDecisionReasonCode[],
  sourceRecheck: SourceRecheck,
  routeRecheck: RouteRecheck,
  relationshipDisclosureRecheck: DisclosureRecheck,
  compensationDisclosureRecheck: DisclosureRecheck,
  safetyRecheck: SafetyRecheck,
  decidedOn: string,
  today: string,
  authorizationExpiresOn: unknown,
): { authorizationExpiresOn: string | null; sendAuthorization: SendAuthorization; authorizationScope: AuthorizationScope } {
  expectReason(
    reasonCodes,
    "source-recheck-incomplete",
    sourceRecheck === "incomplete-or-stale",
    "Source",
  );
  expectReason(
    reasonCodes,
    "route-recheck-incomplete",
    routeRecheck === "unresolved",
    "Route",
  );
  expectReason(
    reasonCodes,
    "inappropriate-route",
    routeRecheck === "inappropriate",
    "Inappropriate-route",
  );
  expectReason(
    reasonCodes,
    "relationship-disclosure-incomplete",
    relationshipDisclosureRecheck === "incomplete",
    "Relationship-disclosure",
  );
  expectReason(
    reasonCodes,
    "compensation-disclosure-incomplete",
    compensationDisclosureRecheck === "incomplete",
    "Compensation-disclosure",
  );
  expectReason(
    reasonCodes,
    "safety-recheck-incomplete",
    safetyRecheck === "incomplete-or-unsafe",
    "Safety",
  );

  const hasAuthorized = reasonCodes.includes("exact-fit-check-send-authorized");
  const hasRevision = reasonCodes.includes("draft-revision-required");
  const hasDeferred = reasonCodes.includes("timing-deferred");
  const hasExplicitRestriction = reasonCodes.includes("explicit-contact-restriction");
  const hasOperatorDoNotSend = reasonCodes.includes("operator-do-not-send");

  if (decision === "authorize-exact-reviewed-draft") {
    if (
      JSON.stringify(reasonCodes) !== JSON.stringify(["exact-fit-check-send-authorized"]) ||
      sourceRecheck !== "reopened-and-fact-confirmed" ||
      routeRecheck !== "appropriate" ||
      relationshipDisclosureRecheck !== "complete-or-not-applicable" ||
      compensationDisclosureRecheck !== "complete-or-not-applicable" ||
      safetyRecheck !== "fit-check-only-boundaries-confirmed"
    ) {
      throw new HumanSendDecisionError("Positive human send decision requires every positive recheck and its exact reason");
    }
    if (decidedOn !== today) {
      throw new HumanSendDecisionError("Positive human send decision must be recorded on the current UTC date");
    }
    const expiry = validCalendarDate(authorizationExpiresOn, "Human send authorization expiry date");
    if (expiry !== decidedOn && expiry !== nextCalendarDate(decidedOn)) {
      throw new HumanSendDecisionError("Human send authorization expiry must be the decision date or next UTC date");
    }
    return {
      authorizationExpiresOn: expiry,
      sendAuthorization: "authorized-for-one-exact-manual-fit-check-send",
      authorizationScope: "one-manual-send-of-exact-reviewed-draft",
    };
  }

  if (authorizationExpiresOn !== undefined && authorizationExpiresOn !== null) {
    throw new HumanSendDecisionError("A nonpositive human send decision cannot carry an authorization expiry");
  }
  if (hasAuthorized) {
    throw new HumanSendDecisionError("A nonpositive human send decision cannot carry the authorization reason");
  }
  if (decision === "require-revision") {
    if (!hasRevision || hasDeferred || hasExplicitRestriction || hasOperatorDoNotSend) {
      throw new HumanSendDecisionError("Require-revision decision must carry only revision and matching recheck reasons");
    }
  } else if (decision === "defer") {
    if (!hasDeferred || hasRevision || hasExplicitRestriction || hasOperatorDoNotSend) {
      throw new HumanSendDecisionError("Defer decision must carry only timing and matching recheck reasons");
    }
  } else {
    const terminal = hasExplicitRestriction || hasOperatorDoNotSend ||
      reasonCodes.includes("inappropriate-route") || reasonCodes.includes("safety-recheck-incomplete");
    if (!terminal || hasRevision || hasDeferred) {
      throw new HumanSendDecisionError("Do-not-send decision requires a terminal reason and no revision or timing reason");
    }
  }
  return {
    authorizationExpiresOn: null,
    sendAuthorization: "not-authorized",
    authorizationScope: "none",
  };
}

function typedDecisionRef(uuidFactory: () => string): string {
  const value = uuidFactory();
  if (!UUID_V4.test(value)) throw new HumanSendDecisionError("Secure send decision reference cannot be generated", 3);
  return "urn:launchrig:send-decision:" + value;
}

async function activeGitWorktreeRoot(startPath: string): Promise<string | null> {
  let current = await realpath(startPath);
  while (true) {
    try {
      const metadata = await lstat(path.join(current, ".git"));
      if (metadata.isSymbolicLink()) throw new HumanSendDecisionError("Active Git worktree metadata is unsafe", 3);
      if (metadata.isDirectory() || metadata.isFile()) return current;
      throw new HumanSendDecisionError("Active Git worktree metadata is unsafe", 3);
    } catch (error) {
      if (error instanceof HumanSendDecisionError) throw error;
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== "ENOENT") {
        throw new HumanSendDecisionError("Active Git worktree cannot be inspected safely", 3);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function privateOutputCandidate(outputPath: string): Promise<string> {
  if (!validPath(outputPath) || !path.isAbsolute(outputPath)) {
    throw new HumanSendDecisionError("Private human send decision output must be a valid absolute path");
  }
  const requestedPath = path.resolve(outputPath);
  const requestedParent = path.dirname(requestedPath);
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(requestedParent);
  } catch {
    throw new HumanSendDecisionError("Private human send decision output parent cannot be resolved safely", 3);
  }
  if (!sameCanonicalPath(requestedParent, canonicalParent)) {
    throw new HumanSendDecisionError("Private human send decision output parent contains a symbolic-link component", 3);
  }
  const metadata = await lstat(canonicalParent, { bigint: true }).catch(() => undefined);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !metadata ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (currentUid !== null && metadata.uid !== BigInt(currentUid)) ||
    (process.platform !== "win32" && (metadata.mode & 0o077n) !== 0n)
  ) {
    throw new HumanSendDecisionError(
      "Private human send decision output parent must be owner-controlled and private",
      3,
    );
  }
  const candidate = path.join(canonicalParent, path.basename(requestedPath));
  const worktreeRoot = await activeGitWorktreeRoot(canonicalParent);
  if (worktreeRoot && isContained(worktreeRoot, candidate)) {
    throw new HumanSendDecisionError("Private human send decision output must be outside every active Git worktree");
  }
  return candidate;
}

function snapshotMatches(
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

function assertStableSnapshot(
  initial: PrivateReviewInputSnapshot,
  current: PrivateReviewInputSnapshot,
  label: string,
): void {
  if (!snapshotMatches(initial, current)) {
    throw new HumanSendDecisionError(label + " changed while the send decision was being recorded", 3);
  }
}

function assertDistinctSnapshots(
  snapshots: readonly PrivateReviewInputSnapshot[],
  outputCandidate: string,
): void {
  for (let leftIndex = 0; leftIndex < snapshots.length; leftIndex += 1) {
    const left = snapshots[leftIndex]!;
    if (sameCanonicalPath(left.canonicalPath, outputCandidate)) {
      throw new HumanSendDecisionError("Private human send decision output must be distinct from every input");
    }
    for (let rightIndex = leftIndex + 1; rightIndex < snapshots.length; rightIndex += 1) {
      const right = snapshots[rightIndex]!;
      if (
        sameCanonicalPath(left.canonicalPath, right.canonicalPath) ||
        (left.dev === right.dev && left.ino === right.ino) ||
        left.sha256 === right.sha256
      ) {
        throw new HumanSendDecisionError(
          "Human send decision inputs must use distinct paths, files, and digests",
        );
      }
    }
  }
}

async function captureInput(
  capture: typeof capturePrivateReviewInput,
  inputPath: string,
  label: string,
): Promise<PrivateReviewInputSnapshot> {
  try {
    return await capture(inputPath, label);
  } catch (error) {
    if (error instanceof HumanSendDecisionError) throw error;
    if (error instanceof ProspectReviewError) {
      throw new HumanSendDecisionError(error.message, error.exitCode);
    }
    throw new HumanSendDecisionError(label + " cannot be read safely", 3);
  }
}

function parseRequest(snapshot: PrivateReviewInputSnapshot): PrivateSendDecisionRequestV1 {
  const source = snapshot.bytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new HumanSendDecisionError("Private Phase 2M request must be strict JSON");
  }
  if (parseDocument(source, { prettyErrors: false, uniqueKeys: true }).errors.length > 0) {
    throw new HumanSendDecisionError(
      "Private Phase 2M request must be strict JSON without duplicate keys",
    );
  }
  try {
    return parsePrivateSendDecisionRequestV1(parsed);
  } catch (error) {
    if (error instanceof SendDecisionPreparationError) {
      throw new HumanSendDecisionError("Private Phase 2M request is not valid and integrity checked");
    }
    throw error;
  }
}

function parseReview(snapshot: PrivateReviewInputSnapshot): PrivateProspectReviewV1 {
  const source = snapshot.bytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new HumanSendDecisionError("Private Phase 2L review must be strict JSON");
  }
  if (parseDocument(source, { prettyErrors: false, uniqueKeys: true }).errors.length > 0) {
    throw new HumanSendDecisionError(
      "Private Phase 2L review must be strict JSON without duplicate keys",
    );
  }
  try {
    return parsePrivateProspectReviewV1(parsed);
  } catch (error) {
    if (error instanceof ProspectReviewError) {
      throw new HumanSendDecisionError("Private Phase 2L review is not valid and integrity checked");
    }
    throw error;
  }
}

function assertRequestAndReviewBindings(
  requestSnapshot: PrivateReviewInputSnapshot,
  request: PrivateSendDecisionRequestV1,
  reviewSnapshot: PrivateReviewInputSnapshot,
  review: PrivateProspectReviewV1,
  prospect: PrivateReviewInputSnapshot,
  draft: PrivateReviewInputSnapshot,
  decidedOn: string,
): void {
  const selected = request.selectedReview;
  if (
    request.preparedOn > decidedOn ||
    review.reviewedOn > request.preparedOn ||
    selected.reviewFileSha256 !== reviewSnapshot.sha256 ||
    selected.reviewContentSha256 !== review.integritySha256 ||
    selected.reviewRef !== review.reviewRef ||
    selected.reviewedOn !== review.reviewedOn ||
    selected.prospectFileSha256 !== prospect.sha256 ||
    selected.draftFileSha256 !== draft.sha256 ||
    selected.prospectLabel !== review.prospect.label ||
    selected.draftLabel !== review.draft.label ||
    request.prospect.fileSha256 !== prospect.sha256 ||
    request.prospect.sizeBytes !== prospect.sizeBytes ||
    request.draft.fileSha256 !== draft.sha256 ||
    request.draft.sizeBytes !== draft.sizeBytes ||
    review.prospect.fileSha256 !== prospect.sha256 ||
    review.prospect.sizeBytes !== prospect.sizeBytes ||
    review.draft.fileSha256 !== draft.sha256 ||
    review.draft.sizeBytes !== draft.sizeBytes ||
    requestSnapshot.sha256 === reviewSnapshot.sha256
  ) {
    throw new HumanSendDecisionError(
      "The request, review, prospect, draft, or decision dates are not an exact related set",
    );
  }
}

async function verifyWrittenHumanSendDecision(
  outputPath: string,
  expectedBytes: Buffer,
  expectedDecision: PrivateHumanSendDecisionV1,
): Promise<void> {
  const snapshot = await capturePrivateReviewInput(outputPath, "Private human send decision output");
  if (!snapshot.bytes.equals(expectedBytes)) throw new Error("written decision bytes changed");
  const parsed = JSON.parse(snapshot.bytes.toString("utf8")) as unknown;
  if (JSON.stringify(parsed) !== JSON.stringify(expectedDecision)) {
    throw new Error("written decision content changed");
  }
  const { integritySha256: _integritySha256, ...core } = expectedDecision;
  if (expectedDecision.integritySha256 !== sha256Value(core)) {
    throw new Error("written decision integrity changed");
  }
}

export async function recordHumanSendDecision(
  options: RecordHumanSendDecisionOptions,
  dependencies: RecordHumanSendDecisionDependencies = {},
): Promise<HumanSendDecisionResultV1> {
  if (options.humanSendDecisionConfirmed !== true) {
    throw new HumanSendDecisionError("Explicit human send decision confirmation is required");
  }
  if (typeof options.authorizerRef !== "string" || !REVIEWER_REF.test(options.authorizerRef)) {
    throw new HumanSendDecisionError("Human send decision authorizer reference is invalid");
  }
  const today = (dependencies.currentDate ?? currentUtcDate)();
  validCalendarDate(today, "Current date");
  const decidedOn = strictDecisionDate(options.decidedOn, today);
  const decision = enumValue(options.decision, HUMAN_SEND_DECISIONS, "Human send decision");
  const reasonCodes = validateReasonCodes(options.reasonCodes);
  const sourceRecheck = enumValue(options.sourceRecheck, SOURCE_RECHECK_VALUES, "Source recheck");
  const routeRecheck = enumValue(options.routeRecheck, ROUTE_RECHECK_VALUES, "Route recheck");
  const relationshipDisclosureRecheck = enumValue(
    options.relationshipDisclosureRecheck,
    DISCLOSURE_RECHECK_VALUES,
    "Relationship disclosure recheck",
  );
  const compensationDisclosureRecheck = enumValue(
    options.compensationDisclosureRecheck,
    DISCLOSURE_RECHECK_VALUES,
    "Compensation disclosure recheck",
  );
  const safetyRecheck = enumValue(options.safetyRecheck, SAFETY_RECHECK_VALUES, "Safety recheck");
  const authorization = validateDecisionMatrix(
    decision,
    reasonCodes,
    sourceRecheck,
    routeRecheck,
    relationshipDisclosureRecheck,
    compensationDisclosureRecheck,
    safetyRecheck,
    decidedOn,
    today,
    options.authorizationExpiresOn,
  );
  const expectedHashes = [
    strictHash(options.expectedRequestSha256, "Expected request SHA-256"),
    strictHash(options.expectedReviewSha256, "Expected review SHA-256"),
    strictHash(options.expectedProspectSha256, "Expected prospect SHA-256"),
    strictHash(options.expectedDraftSha256, "Expected draft SHA-256"),
  ];
  const outputCandidate = await privateOutputCandidate(options.outputPath);

  const capture = dependencies.capturePrivateInput ?? capturePrivateReviewInput;
  const paths = [options.requestPath, options.reviewPath, options.prospectPath, options.draftPath];
  const labels = [
    "Private Phase 2M request",
    "Private Phase 2L review",
    "Private prospect input",
    "Private draft input",
  ] as const;
  const snapshots = await Promise.all(paths.map((inputPath, index) =>
    captureInput(capture, inputPath, labels[index]!),
  ));
  assertDistinctSnapshots(snapshots, outputCandidate);
  snapshots.forEach((snapshot, index) => {
    if (snapshot.sha256 !== expectedHashes[index]) {
      throw new HumanSendDecisionError("An input does not match its explicitly confirmed SHA-256");
    }
  });
  const [requestSnapshot, reviewSnapshot, prospect, draft] = snapshots as [
    PrivateReviewInputSnapshot,
    PrivateReviewInputSnapshot,
    PrivateReviewInputSnapshot,
    PrivateReviewInputSnapshot,
  ];
  const request = parseRequest(requestSnapshot);
  const review = parseReview(reviewSnapshot);
  assertRequestAndReviewBindings(
    requestSnapshot,
    request,
    reviewSnapshot,
    review,
    prospect,
    draft,
    decidedOn,
  );

  const decisionCore = {
    schemaVersion: 1 as const,
    kind: "launchrig-private-human-send-decision" as const,
    profile: "phase-2n-human-send-decision-v1" as const,
    privacyProfile: "opaque-authorizer-digests-decision-v1" as const,
    decisionRef: typedDecisionRef(dependencies.randomUuid ?? randomUUID),
    decidedOn,
    authorizerRef: options.authorizerRef,
    claimStatus: "human-operator-recorded-unattested" as const,
    humanSendDecisionConfirmed: true as const,
    humanNoAdditionalRelatedReviewConfirmed: true as const,
    humanAuthorizerAuthenticated: false as const,
    reviewSetCompleteness: "operator-asserted-unattested" as const,
    conflictStatus: "none-detected-in-operator-supplied-set" as const,
    latestStatus: "not-established" as const,
    reviewSetCount: 1 as const,
    request: {
      fileSha256: requestSnapshot.sha256,
      contentSha256: request.integritySha256,
      preparedOn: request.preparedOn,
      reviewSetSha256: request.reviewSetSha256,
    },
    review: {
      fileSha256: reviewSnapshot.sha256,
      contentSha256: review.integritySha256,
      reviewRef: review.reviewRef,
      reviewedOn: review.reviewedOn,
    },
    prospect: {
      fileSha256: prospect.sha256,
      sizeBytes: prospect.sizeBytes,
    },
    draft: {
      fileSha256: draft.sha256,
      sizeBytes: draft.sizeBytes,
    },
    decision,
    reasonCodes,
    sourceRecheck,
    routeRecheck,
    relationshipDisclosureRecheck,
    compensationDisclosureRecheck,
    safetyRecheck,
    authorizationExpiresOn: authorization.authorizationExpiresOn,
    sendAuthorization: authorization.sendAuthorization,
    authorizationScope: authorization.authorizationScope,
    contact: "not-contacted" as const,
    messageDispatched: false as const,
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
    limitations: [...HUMAN_SEND_DECISION_LIMITATIONS],
  };
  const humanDecision: PrivateHumanSendDecisionV1 = {
    ...decisionCore,
    integritySha256: sha256Value(decisionCore),
  };
  const bytes = Buffer.from(JSON.stringify(humanDecision, null, 2) + "\n", "utf8");

  const beforeWrite = await Promise.all(paths.map((inputPath, index) =>
    captureInput(capture, inputPath, labels[index]!),
  ));
  snapshots.forEach((snapshot, index) => {
    assertStableSnapshot(snapshot, beforeWrite[index]!, labels[index]!);
  });

  let writtenIdentity: PrivateFileIdentity;
  try {
    writtenIdentity = await (dependencies.writePrivateFile ?? writeNewPrivateFileNoFollow)(
      options.outputPath,
      bytes,
    );
  } catch (error) {
    if (error instanceof SecureFileError && error.reason === "exists") {
      throw new HumanSendDecisionError("Private human send decision output already exists");
    }
    throw new HumanSendDecisionError(
      "Private human send decision cannot be written safely; a mode-600 output may remain for manual inspection",
      3,
    );
  }

  try {
    const afterWrite = await Promise.all(paths.map((inputPath, index) =>
      captureInput(capture, inputPath, labels[index]!),
    ));
    snapshots.forEach((snapshot, index) => {
      assertStableSnapshot(snapshot, afterWrite[index]!, labels[index]!);
    });
    await (dependencies.verifyWrittenDecision ?? verifyWrittenHumanSendDecision)(
      writtenIdentity.canonicalPath,
      bytes,
      humanDecision,
    );
    if (!(await (dependencies.privateFileIdentityMatches ?? privateFileIdentityMatches)(writtenIdentity))) {
      throw new Error("written decision identity changed");
    }
  } catch {
    throw new HumanSendDecisionError(
      "Private human send decision failed final verification; a mode-600 output may remain for manual inspection",
      3,
    );
  }

  return {
    schemaVersion: 1,
    kind: "launchrig-private-human-send-decision-result",
    profile: "phase-2n-human-send-decision-v1",
    status: "created",
    claimStatus: "human-operator-recorded-unattested",
    humanSendDecisionConfirmed: true,
    humanNoAdditionalRelatedReviewConfirmed: true,
    humanAuthorizerAuthenticated: false,
    reviewSetCompleteness: "operator-asserted-unattested",
    conflictStatus: "none-detected-in-operator-supplied-set",
    latestStatus: "not-established",
    reviewSetCount: 1,
    decisionFileSha256: writtenIdentity.sha256,
    decisionContentSha256: humanDecision.integritySha256,
    requestFileSha256: requestSnapshot.sha256,
    requestContentSha256: request.integritySha256,
    reviewFileSha256: reviewSnapshot.sha256,
    reviewContentSha256: review.integritySha256,
    prospectFileSha256: prospect.sha256,
    draftFileSha256: draft.sha256,
    reviewSetSha256: request.reviewSetSha256,
    decision,
    reasonCodes,
    sourceRecheck,
    routeRecheck,
    relationshipDisclosureRecheck,
    compensationDisclosureRecheck,
    safetyRecheck,
    authorizationExpiresOn: authorization.authorizationExpiresOn,
    sendAuthorization: authorization.sendAuthorization,
    authorizationScope: authorization.authorizationScope,
    contact: "not-contacted",
    messageDispatched: false,
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
    limitations: [...HUMAN_SEND_DECISION_LIMITATIONS],
  };
}
