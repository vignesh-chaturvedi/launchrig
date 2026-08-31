import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
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
import { sha256Value } from "./store.js";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const OPERATOR_REF = new RegExp("^urn:launchrig:reviewer:" + UUID_V4.source.slice(1, -1) + "$");

export const SEND_DECISION_PREPARATION_LIMITATIONS = [
  "This private request records an operator-supplied review set for exact prospect, draft, and review bytes. It does not authenticate the operator, reviewer, publisher, source, route, disclosure, or safety findings.",
  "Review-set completeness is an unattested operator assertion. No receipt is inferred to be latest, and any additional related receipt leaves the send decision unresolved.",
  "Preparation records no human send decision, grants no send authorization, performs no contact, and dispatches no message.",
  "Any change to the prospect, draft, selected review, or operator-supplied related review set invalidates this request and requires a new preparation.",
  "Source, route, relationship disclosure, compensation disclosure, and safety rechecks remain not recorded for the later exact human send decision.",
  "File ownership and mode checks do not prove ACL, backup, sync, process-list, shell-history, or cloud-storage privacy.",
  "Publisher identity, authority, consent, independence, external testing, confirmed defects, and grant readiness remain not established.",
] as const;

export interface PrepareSendDecisionOptions {
  selectedReviewPath: string;
  expectedSelectedReviewSha256: string;
  prospectPath: string;
  expectedProspectSha256: string;
  draftPath: string;
  expectedDraftSha256: string;
  relatedReviewPaths?: readonly string[];
  expectedRelatedReviewSha256?: readonly string[];
  operatorRef: string;
  preparedOn: string;
  humanRelatedReviewSetConfirmed: boolean;
  outputPath: string;
}

export interface SendDecisionReviewSetEntryV1 {
  reviewFileSha256: string;
  reviewContentSha256: string;
  reviewRef: string;
  reviewedOn: string;
  prospectFileSha256: string;
  draftFileSha256: string;
  prospectLabel: "operator-reviewed-consider-outreach";
  draftLabel: "operator-reviewed-awaiting-separate-send-authorization";
}

export interface PrivateSendDecisionRequestV1 {
  schemaVersion: 1;
  kind: "launchrig-private-send-decision-request";
  profile: "phase-2m-send-decision-preparation-v1";
  privacyProfile: "opaque-operator-digests-dates-v1";
  preparedOn: string;
  operatorRef: string;
  claimStatus: "operator-prepared-unattested";
  reviewSetCompleteness: "operator-asserted-unattested";
  conflictStatus: "none-detected-in-operator-supplied-set";
  latestStatus: "not-established";
  preparationStatus: "awaiting-exact-human-send-decision";
  humanRelatedReviewSetConfirmed: true;
  humanSendDecisionRecorded: false;
  humanAuthorizerAuthenticated: false;
  selectedReview: SendDecisionReviewSetEntryV1;
  reviewSet: SendDecisionReviewSetEntryV1[];
  reviewSetSha256: string;
  prospect: {
    fileSha256: string;
    sizeBytes: number;
  };
  draft: {
    fileSha256: string;
    sizeBytes: number;
  };
  sourceRecheck: "not-recorded";
  routeRecheck: "not-recorded";
  relationshipDisclosureRecheck: "not-recorded";
  compensationDisclosureRecheck: "not-recorded";
  safetyRecheck: "not-recorded";
  contact: "not-contacted";
  sendAuthorization: "not-authorized";
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

export interface SendDecisionRequestResultV1 {
  schemaVersion: 1;
  kind: "launchrig-private-send-decision-request-result";
  profile: "phase-2m-send-decision-preparation-v1";
  status: "created";
  claimStatus: "operator-prepared-unattested";
  reviewSetCompleteness: "operator-asserted-unattested";
  conflictStatus: "none-detected-in-operator-supplied-set";
  latestStatus: "not-established";
  preparationStatus: "awaiting-exact-human-send-decision";
  humanRelatedReviewSetConfirmed: true;
  humanSendDecisionRecorded: false;
  humanAuthorizerAuthenticated: false;
  requestFileSha256: string;
  requestContentSha256: string;
  selectedReviewFileSha256: string;
  selectedReviewContentSha256: string;
  prospectFileSha256: string;
  draftFileSha256: string;
  reviewSetCount: 1;
  reviewSetSha256: string;
  sourceRecheck: "not-recorded";
  routeRecheck: "not-recorded";
  relationshipDisclosureRecheck: "not-recorded";
  compensationDisclosureRecheck: "not-recorded";
  safetyRecheck: "not-recorded";
  contact: "not-contacted";
  sendAuthorization: "not-authorized";
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

export class SendDecisionPreparationError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 2 | 3 = 2,
  ) {
    super(message);
    this.name = "SendDecisionPreparationError";
  }
}

export interface PrepareSendDecisionDependencies {
  capturePrivateInput?: typeof capturePrivateReviewInput;
  writePrivateFile?: typeof writeNewPrivateFileNoFollow;
  privateFileIdentityMatches?: typeof privateFileIdentityMatches;
  verifyWrittenRequest?: typeof verifyWrittenSendDecisionRequest;
  currentDate?: () => string;
}

interface CapturedReview {
  snapshot: PrivateReviewInputSnapshot;
  review: PrivateProspectReviewV1;
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

function strictHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new SendDecisionPreparationError(label + " must be an explicit lowercase SHA-256 value");
  }
  return value;
}

function currentUtcDate(): string {
  const now = new Date();
  if (!Number.isFinite(now.valueOf())) {
    throw new SendDecisionPreparationError("Current date is invalid", 3);
  }
  return now.toISOString().slice(0, 10);
}

function strictDate(value: unknown, today: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new SendDecisionPreparationError("Send decision preparation date is invalid");
  }
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new SendDecisionPreparationError("Send decision preparation date is invalid");
  }
  if (value > today) {
    throw new SendDecisionPreparationError("Send decision preparation date cannot be in the future");
  }
  return value;
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
      if (metadata.isSymbolicLink()) {
        throw new SendDecisionPreparationError("Active Git worktree metadata is unsafe", 3);
      }
      if (metadata.isDirectory() || metadata.isFile()) return current;
      throw new SendDecisionPreparationError("Active Git worktree metadata is unsafe", 3);
    } catch (error) {
      if (error instanceof SendDecisionPreparationError) throw error;
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== "ENOENT") {
        throw new SendDecisionPreparationError("Active Git worktree cannot be inspected safely", 3);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function privateOutputCandidate(outputPath: string): Promise<string> {
  if (!validPath(outputPath) || !path.isAbsolute(outputPath)) {
    throw new SendDecisionPreparationError("Private send decision request output must be a valid absolute path");
  }
  const requestedPath = path.resolve(outputPath);
  const requestedParent = path.dirname(requestedPath);
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(requestedParent);
  } catch {
    throw new SendDecisionPreparationError("Private send decision request output parent cannot be resolved safely", 3);
  }
  if (!sameCanonicalPath(requestedParent, canonicalParent)) {
    throw new SendDecisionPreparationError(
      "Private send decision request output parent contains a symbolic-link component",
      3,
    );
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
    throw new SendDecisionPreparationError(
      "Private send decision request output parent must be owner-controlled and private",
      3,
    );
  }
  const candidate = path.join(canonicalParent, path.basename(requestedPath));
  const worktreeRoot = await activeGitWorktreeRoot(canonicalParent);
  if (worktreeRoot && isContained(worktreeRoot, candidate)) {
    throw new SendDecisionPreparationError(
      "Private send decision request output must be outside every active Git worktree",
    );
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
    throw new SendDecisionPreparationError(label + " changed while the request was being prepared", 3);
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
    if (error instanceof SendDecisionPreparationError) throw error;
    if (error instanceof ProspectReviewError) {
      throw new SendDecisionPreparationError(error.message, error.exitCode);
    }
    throw new SendDecisionPreparationError(label + " cannot be read safely", 3);
  }
}

function parseReview(snapshot: PrivateReviewInputSnapshot, label: string): PrivateProspectReviewV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.bytes.toString("utf8"));
  } catch {
    throw new SendDecisionPreparationError(label + " must be strict JSON");
  }
  try {
    return parsePrivateProspectReviewV1(parsed);
  } catch (error) {
    if (error instanceof ProspectReviewError) {
      throw new SendDecisionPreparationError(label + " is not a valid integrity-checked Phase 2L receipt");
    }
    throw error;
  }
}

function reviewSetEntry(captured: CapturedReview): SendDecisionReviewSetEntryV1 {
  return {
    reviewFileSha256: captured.snapshot.sha256,
    reviewContentSha256: captured.review.integritySha256,
    reviewRef: captured.review.reviewRef,
    reviewedOn: captured.review.reviewedOn,
    prospectFileSha256: captured.review.prospect.fileSha256,
    draftFileSha256: captured.review.draft.fileSha256,
    prospectLabel: "operator-reviewed-consider-outreach",
    draftLabel: "operator-reviewed-awaiting-separate-send-authorization",
  };
}

function sortedReviewSet(entries: readonly SendDecisionReviewSetEntryV1[]): SendDecisionReviewSetEntryV1[] {
  return [...entries].sort((left, right) =>
    left.reviewFileSha256.localeCompare(right.reviewFileSha256) ||
    left.reviewContentSha256.localeCompare(right.reviewContentSha256) ||
    left.reviewRef.localeCompare(right.reviewRef),
  );
}

export function sendDecisionReviewSetSha256(
  entries: readonly SendDecisionReviewSetEntryV1[],
): string {
  return sha256Value(sortedReviewSet(entries));
}

function assertDistinctSnapshots(snapshots: readonly PrivateReviewInputSnapshot[], label: string): void {
  for (let leftIndex = 0; leftIndex < snapshots.length; leftIndex += 1) {
    const left = snapshots[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < snapshots.length; rightIndex += 1) {
      const right = snapshots[rightIndex]!;
      if (
        sameCanonicalPath(left.canonicalPath, right.canonicalPath) ||
        (left.dev === right.dev && left.ino === right.ino) ||
        left.sha256 === right.sha256
      ) {
        throw new SendDecisionPreparationError(label + " must not contain duplicate paths, files, or digests");
      }
    }
  }
}

function assertReviewBindsInputs(
  review: PrivateProspectReviewV1,
  prospect: PrivateReviewInputSnapshot,
  draft: PrivateReviewInputSnapshot,
  label: string,
): void {
  if (
    review.prospect.fileSha256 !== prospect.sha256 ||
    review.prospect.sizeBytes !== prospect.sizeBytes ||
    review.draft.fileSha256 !== draft.sha256 ||
    review.draft.sizeBytes !== draft.sizeBytes
  ) {
    throw new SendDecisionPreparationError(label + " is unrelated to the exact prospect and draft inputs");
  }
}

async function verifyWrittenSendDecisionRequest(
  outputPath: string,
  expectedBytes: Buffer,
  expectedRequest: PrivateSendDecisionRequestV1,
): Promise<void> {
  const snapshot = await capturePrivateReviewInput(outputPath, "Private send decision request output");
  if (!snapshot.bytes.equals(expectedBytes)) throw new Error("written request bytes changed");
  const parsed = JSON.parse(snapshot.bytes.toString("utf8")) as unknown;
  if (JSON.stringify(parsed) !== JSON.stringify(expectedRequest)) {
    throw new Error("written request content changed");
  }
  const { integritySha256: _integritySha256, ...core } = expectedRequest;
  if (expectedRequest.integritySha256 !== sha256Value(core)) {
    throw new Error("written request integrity changed");
  }
  if (expectedRequest.reviewSetSha256 !== sendDecisionReviewSetSha256(expectedRequest.reviewSet)) {
    throw new Error("written review-set integrity changed");
  }
}

export async function prepareSendDecisionRequest(
  options: PrepareSendDecisionOptions,
  dependencies: PrepareSendDecisionDependencies = {},
): Promise<SendDecisionRequestResultV1> {
  if (options.humanRelatedReviewSetConfirmed !== true) {
    throw new SendDecisionPreparationError("Explicit related review set confirmation is required");
  }
  if (typeof options.operatorRef !== "string" || !OPERATOR_REF.test(options.operatorRef)) {
    throw new SendDecisionPreparationError("Send decision preparation operator reference is invalid");
  }
  const preparedOn = strictDate(options.preparedOn, (dependencies.currentDate ?? currentUtcDate)());
  const expectedSelectedReviewSha256 = strictHash(
    options.expectedSelectedReviewSha256,
    "Expected selected review SHA-256",
  );
  const expectedProspectSha256 = strictHash(options.expectedProspectSha256, "Expected prospect SHA-256");
  const expectedDraftSha256 = strictHash(options.expectedDraftSha256, "Expected draft SHA-256");
  const relatedReviewPaths = options.relatedReviewPaths ?? [];
  const expectedRelatedReviewSha256 = options.expectedRelatedReviewSha256 ?? [];
  if (!Array.isArray(relatedReviewPaths) || !Array.isArray(expectedRelatedReviewSha256)) {
    throw new SendDecisionPreparationError("Related review paths and expected hashes must be arrays");
  }
  if (relatedReviewPaths.length !== expectedRelatedReviewSha256.length) {
    throw new SendDecisionPreparationError("Every related review path requires one matching expected SHA-256");
  }
  if (relatedReviewPaths.length > 64) {
    throw new SendDecisionPreparationError("The related review set is too large");
  }
  const relatedExpectedHashes = expectedRelatedReviewSha256.map((value) =>
    strictHash(value, "Expected related review SHA-256"),
  );
  const outputCandidate = await privateOutputCandidate(options.outputPath);

  const capture = dependencies.capturePrivateInput ?? capturePrivateReviewInput;
  const [selectedSnapshot, prospect, draft, ...relatedSnapshots] = await Promise.all([
    captureInput(capture, options.selectedReviewPath, "Selected private Phase 2L review"),
    captureInput(capture, options.prospectPath, "Private prospect input"),
    captureInput(capture, options.draftPath, "Private draft input"),
    ...relatedReviewPaths.map((reviewPath) =>
      captureInput(capture, reviewPath, "Related private Phase 2L review"),
    ),
  ]);
  const allSnapshots = [selectedSnapshot, prospect, draft, ...relatedSnapshots];
  assertDistinctSnapshots(allSnapshots, "Send decision preparation inputs");
  if (allSnapshots.some((snapshot) => sameCanonicalPath(snapshot.canonicalPath, outputCandidate))) {
    throw new SendDecisionPreparationError("Private send decision request output must be distinct from every input");
  }
  if (
    selectedSnapshot.sha256 !== expectedSelectedReviewSha256 ||
    prospect.sha256 !== expectedProspectSha256 ||
    draft.sha256 !== expectedDraftSha256 ||
    relatedSnapshots.some((snapshot, index) => snapshot.sha256 !== relatedExpectedHashes[index])
  ) {
    throw new SendDecisionPreparationError("An input does not match its explicitly confirmed SHA-256");
  }

  const selectedReview = parseReview(selectedSnapshot, "Selected private Phase 2L review");
  if (
    selectedReview.prospect.label !== "operator-reviewed-consider-outreach" ||
    selectedReview.draft.label !== "operator-reviewed-awaiting-separate-send-authorization"
  ) {
    throw new SendDecisionPreparationError(
      "Selected review must record consider-outreach and awaiting separate send authorization",
    );
  }
  if (selectedReview.reviewedOn > preparedOn) {
    throw new SendDecisionPreparationError("Selected review date cannot be later than the preparation date");
  }
  assertReviewBindsInputs(selectedReview, prospect, draft, "Selected private Phase 2L review");

  const relatedReviews = relatedSnapshots.map((snapshot) => ({
    snapshot,
    review: parseReview(snapshot, "Related private Phase 2L review"),
  }));
  for (const related of relatedReviews) {
    assertReviewBindsInputs(related.review, prospect, draft, "Related private Phase 2L review");
    if (related.review.reviewedOn > preparedOn) {
      throw new SendDecisionPreparationError("Related review date cannot be later than the preparation date");
    }
  }
  if (relatedReviews.length > 0) {
    throw new SendDecisionPreparationError(
      "An additional related review leaves conflicts and latest status unresolved; no request was created",
    );
  }

  const selected: CapturedReview = { snapshot: selectedSnapshot, review: selectedReview };
  const selectedEntry = reviewSetEntry(selected);
  const reviewSet = sortedReviewSet([selectedEntry]);
  const reviewSetSha256 = sendDecisionReviewSetSha256(reviewSet);
  const requestCore = {
    schemaVersion: 1 as const,
    kind: "launchrig-private-send-decision-request" as const,
    profile: "phase-2m-send-decision-preparation-v1" as const,
    privacyProfile: "opaque-operator-digests-dates-v1" as const,
    preparedOn,
    operatorRef: options.operatorRef,
    claimStatus: "operator-prepared-unattested" as const,
    reviewSetCompleteness: "operator-asserted-unattested" as const,
    conflictStatus: "none-detected-in-operator-supplied-set" as const,
    latestStatus: "not-established" as const,
    preparationStatus: "awaiting-exact-human-send-decision" as const,
    humanRelatedReviewSetConfirmed: true as const,
    humanSendDecisionRecorded: false as const,
    humanAuthorizerAuthenticated: false as const,
    selectedReview: selectedEntry,
    reviewSet,
    reviewSetSha256,
    prospect: {
      fileSha256: prospect.sha256,
      sizeBytes: prospect.sizeBytes,
    },
    draft: {
      fileSha256: draft.sha256,
      sizeBytes: draft.sizeBytes,
    },
    sourceRecheck: "not-recorded" as const,
    routeRecheck: "not-recorded" as const,
    relationshipDisclosureRecheck: "not-recorded" as const,
    compensationDisclosureRecheck: "not-recorded" as const,
    safetyRecheck: "not-recorded" as const,
    contact: "not-contacted" as const,
    sendAuthorization: "not-authorized" as const,
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
    limitations: [...SEND_DECISION_PREPARATION_LIMITATIONS],
  };
  const request: PrivateSendDecisionRequestV1 = {
    ...requestCore,
    integritySha256: sha256Value(requestCore),
  };
  const requestBytes = Buffer.from(JSON.stringify(request, null, 2) + "\n", "utf8");

  const inputPaths = [
    options.selectedReviewPath,
    options.prospectPath,
    options.draftPath,
    ...relatedReviewPaths,
  ];
  const beforeWrite = await Promise.all(
    inputPaths.map((inputPath, index) =>
      captureInput(capture, inputPath, index === 0
        ? "Selected private Phase 2L review"
        : index === 1
          ? "Private prospect input"
          : index === 2
            ? "Private draft input"
            : "Related private Phase 2L review"),
    ),
  );
  allSnapshots.forEach((snapshot, index) => {
    assertStableSnapshot(snapshot, beforeWrite[index]!, "Private send decision preparation input");
  });

  let writtenIdentity: PrivateFileIdentity;
  try {
    writtenIdentity = await (dependencies.writePrivateFile ?? writeNewPrivateFileNoFollow)(
      options.outputPath,
      requestBytes,
    );
  } catch (error) {
    if (error instanceof SecureFileError && error.reason === "exists") {
      throw new SendDecisionPreparationError("Private send decision request output already exists");
    }
    throw new SendDecisionPreparationError(
      "Private send decision request cannot be written safely; a mode-600 output may remain for manual inspection",
      3,
    );
  }

  try {
    const afterWrite = await Promise.all(
      inputPaths.map((inputPath, index) =>
        captureInput(capture, inputPath, index === 0
          ? "Selected private Phase 2L review"
          : index === 1
            ? "Private prospect input"
            : index === 2
              ? "Private draft input"
              : "Related private Phase 2L review"),
      ),
    );
    allSnapshots.forEach((snapshot, index) => {
      assertStableSnapshot(snapshot, afterWrite[index]!, "Private send decision preparation input");
    });
    await (dependencies.verifyWrittenRequest ?? verifyWrittenSendDecisionRequest)(
      writtenIdentity.canonicalPath,
      requestBytes,
      request,
    );
    if (!(await (dependencies.privateFileIdentityMatches ?? privateFileIdentityMatches)(writtenIdentity))) {
      throw new Error("written request identity changed");
    }
  } catch {
    throw new SendDecisionPreparationError(
      "Private send decision request failed final verification; a mode-600 output may remain for manual inspection",
      3,
    );
  }

  return {
    schemaVersion: 1,
    kind: "launchrig-private-send-decision-request-result",
    profile: "phase-2m-send-decision-preparation-v1",
    status: "created",
    claimStatus: "operator-prepared-unattested",
    reviewSetCompleteness: "operator-asserted-unattested",
    conflictStatus: "none-detected-in-operator-supplied-set",
    latestStatus: "not-established",
    preparationStatus: "awaiting-exact-human-send-decision",
    humanRelatedReviewSetConfirmed: true,
    humanSendDecisionRecorded: false,
    humanAuthorizerAuthenticated: false,
    requestFileSha256: writtenIdentity.sha256,
    requestContentSha256: request.integritySha256,
    selectedReviewFileSha256: selectedSnapshot.sha256,
    selectedReviewContentSha256: selectedReview.integritySha256,
    prospectFileSha256: prospect.sha256,
    draftFileSha256: draft.sha256,
    reviewSetCount: 1,
    reviewSetSha256,
    sourceRecheck: "not-recorded",
    routeRecheck: "not-recorded",
    relationshipDisclosureRecheck: "not-recorded",
    compensationDisclosureRecheck: "not-recorded",
    safetyRecheck: "not-recorded",
    contact: "not-contacted",
    sendAuthorization: "not-authorized",
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
    limitations: [...SEND_DECISION_PREPARATION_LIMITATIONS],
  };
}
