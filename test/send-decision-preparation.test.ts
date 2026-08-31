import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  capturePrivateReviewInput,
  type ProspectReviewFindings,
  recordProspectReview,
} from "../src/pilot/prospect-review.js";
import {
  type PrepareSendDecisionOptions,
  prepareSendDecisionRequest,
  sendDecisionReviewSetSha256,
  SendDecisionPreparationError,
} from "../src/pilot/send-decision-preparation.js";
import { sha256Value } from "../src/pilot/store.js";

const REVIEWER_REF = "urn:launchrig:reviewer:00000011-0000-4000-a000-000000000011";
const OPERATOR_REF = "urn:launchrig:reviewer:00000012-0000-4000-a000-000000000012";

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function positiveFindings(): ProspectReviewFindings {
  return {
    citedSource: "reopened-and-fact-confirmed",
    unobservedDetails: "preserved-as-unknown",
    contactRoute: "appropriate",
    relationshipDisclosure: "complete-or-not-applicable",
    compensationDisclosure: "complete-or-not-applicable",
    messageScope: "fit-check-only",
    installationOrAccessRequest: "absent",
    financialRisk: "excluded",
    biometricRisk: "excluded",
    credentialRisk: "excluded",
    deviceControlRisk: "excluded",
    locationRisk: "excluded",
    productionAccountRisk: "excluded",
    mainnetRisk: "excluded",
    valuableFundsRisk: "excluded",
  };
}

interface SyntheticFixture {
  directory: string;
  prospectPath: string;
  draftPath: string;
  reviewPath: string;
  outputPath: string;
  prospectBytes: Buffer;
  draftBytes: Buffer;
}

async function controlledSyntheticFixture(name: string, reviewUuid = 21): Promise<SyntheticFixture> {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "launchrig-controlled-synthetic-send-" + name + "-")),
  );
  await chmod(directory, 0o700);
  const prospectPath = path.join(directory, "controlled-synthetic-prospect.md");
  const draftPath = path.join(directory, "controlled-synthetic-draft.md");
  const reviewPath = path.join(directory, "controlled-synthetic-review.json");
  const outputPath = path.join(directory, "controlled-synthetic-send-request.json");
  const prospectBytes = Buffer.from(
    "# Controlled synthetic prospect\n\nSynthetic fact for contract testing only.\n",
    "utf8",
  );
  const draftBytes = Buffer.from(
    "# Controlled synthetic draft\n\nWould you consider a synthetic fit check?\n",
    "utf8",
  );
  await writeFile(prospectPath, prospectBytes, { mode: 0o600 });
  await writeFile(draftPath, draftBytes, { mode: 0o600 });
  await chmod(prospectPath, 0o600);
  await chmod(draftPath, 0o600);
  const uuid = reviewUuid.toString(16).padStart(8, "0") + "-0000-4000-a000-000000000021";
  await recordProspectReview(
    {
      prospectPath,
      expectedProspectSha256: digest(prospectBytes),
      draftPath,
      expectedDraftSha256: digest(draftBytes),
      reviewerRef: REVIEWER_REF,
      reviewedOn: "2026-08-30",
      prospectLabel: "operator-reviewed-consider-outreach",
      draftLabel: "operator-reviewed-awaiting-separate-send-authorization",
      reasonCodes: ["fit-check-boundary-reviewed"],
      findings: positiveFindings(),
      humanReviewConfirmed: true,
      outputPath: reviewPath,
    },
    {
      randomUuid: () => uuid,
      currentDate: () => "2026-08-31",
    },
  );
  return {
    directory,
    prospectPath,
    draftPath,
    reviewPath,
    outputPath,
    prospectBytes,
    draftBytes,
  };
}

async function requestOptions(value: SyntheticFixture): Promise<PrepareSendDecisionOptions> {
  return {
    selectedReviewPath: value.reviewPath,
    expectedSelectedReviewSha256: digest(await readFile(value.reviewPath)),
    prospectPath: value.prospectPath,
    expectedProspectSha256: digest(value.prospectBytes),
    draftPath: value.draftPath,
    expectedDraftSha256: digest(value.draftBytes),
    operatorRef: OPERATOR_REF,
    preparedOn: "2026-08-31",
    humanRelatedReviewSetConfirmed: true,
    outputPath: value.outputPath,
  };
}

const preparationDependencies = {
  currentDate: () => "2026-08-31",
};

test("prepareSendDecisionRequest creates a private request from controlled synthetic exact inputs", async () => {
  const value = await controlledSyntheticFixture("create");
  try {
    const result = await prepareSendDecisionRequest(await requestOptions(value), preparationDependencies);
    const requestBytes = await readFile(value.outputPath);
    const request = JSON.parse(requestBytes.toString("utf8")) as Record<string, any>;
    const metadata = await lstat(value.outputPath);

    assert.equal(result.kind, "launchrig-private-send-decision-request-result");
    assert.equal(result.status, "created");
    assert.equal(result.claimStatus, "operator-prepared-unattested");
    assert.equal(result.reviewSetCompleteness, "operator-asserted-unattested");
    assert.equal(result.conflictStatus, "none-detected-in-operator-supplied-set");
    assert.equal(result.latestStatus, "not-established");
    assert.equal(result.preparationStatus, "awaiting-exact-human-send-decision");
    assert.equal(result.humanRelatedReviewSetConfirmed, true);
    assert.equal(result.humanSendDecisionRecorded, false);
    assert.equal(result.humanAuthorizerAuthenticated, false);
    assert.equal(result.messageDispatched, false);
    assert.equal(result.contact, "not-contacted");
    assert.equal(result.sendAuthorization, "not-authorized");
    assert.equal(result.requestFileSha256, digest(requestBytes));
    assert.equal(result.requestContentSha256, request.integritySha256);
    assert.equal(result.reviewSetCount, 1);
    assert.equal(result.reviewSetSha256, sendDecisionReviewSetSha256(request.reviewSet));
    assert.equal(request.reviewSetSha256, result.reviewSetSha256);
    assert.deepEqual(request.reviewSet, [request.selectedReview]);
    assert.equal(request.selectedReview.prospectLabel, "operator-reviewed-consider-outreach");
    assert.equal(
      request.selectedReview.draftLabel,
      "operator-reviewed-awaiting-separate-send-authorization",
    );
    assert.equal(request.prospect.fileSha256, digest(value.prospectBytes));
    assert.equal(request.prospect.sizeBytes, value.prospectBytes.length);
    assert.equal(request.draft.fileSha256, digest(value.draftBytes));
    assert.equal(request.draft.sizeBytes, value.draftBytes.length);
    const { integritySha256: _integritySha256, ...core } = request;
    assert.equal(request.integritySha256, sha256Value(core));

    assert.ok(metadata.isFile());
    assert.equal(metadata.nlink, 1);
    if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o600);
    if (typeof process.getuid === "function") assert.equal(metadata.uid, process.getuid());

    const publicResult = JSON.stringify(result);
    assert.doesNotMatch(publicResult, /urn:launchrig:/);
    assert.doesNotMatch(publicResult, /controlled-synthetic-(?:prospect|draft|review|send-request)/);
    assert.doesNotMatch(
      publicResult,
      new RegExp(value.directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.doesNotMatch(publicResult, /Synthetic fact|synthetic fit check/);

    const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
    ajv.addFormat("date", /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    const requestSchema = JSON.parse(
      await readFile(
        path.join(process.cwd(), "schemas", "launchrig-private-send-decision-request.schema.json"),
        "utf8",
      ),
    );
    const resultSchema = JSON.parse(
      await readFile(
        path.join(process.cwd(), "schemas", "launchrig-private-send-decision-request-result.schema.json"),
        "utf8",
      ),
    );
    const validateRequest = ajv.compile(requestSchema);
    const validateResult = ajv.compile(resultSchema);
    assert.equal(validateRequest(request), true, JSON.stringify(validateRequest.errors));
    assert.equal(validateResult(result), true, JSON.stringify(validateResult.errors));
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("send decision schemas reject controlled synthetic safety-state mutations", async () => {
  const value = await controlledSyntheticFixture("schema");
  try {
    const result = await prepareSendDecisionRequest(await requestOptions(value), preparationDependencies);
    const request = JSON.parse(await readFile(value.outputPath, "utf8")) as Record<string, any>;
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
    ajv.addFormat("date", /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    const requestSchema = JSON.parse(
      await readFile(
        path.join(process.cwd(), "schemas", "launchrig-private-send-decision-request.schema.json"),
        "utf8",
      ),
    );
    const resultSchema = JSON.parse(
      await readFile(
        path.join(process.cwd(), "schemas", "launchrig-private-send-decision-request-result.schema.json"),
        "utf8",
      ),
    );
    const validateRequest = ajv.compile(requestSchema);
    const validateResult = ajv.compile(resultSchema);
    const requestMutations: Array<(candidate: Record<string, any>) => void> = [
      (candidate) => { candidate.humanSendDecisionRecorded = true; },
      (candidate) => { candidate.humanAuthorizerAuthenticated = true; },
      (candidate) => { candidate.sendAuthorization = "authorized"; },
      (candidate) => { candidate.messageDispatched = true; },
      (candidate) => { candidate.latestStatus = "latest"; },
      (candidate) => { candidate.sourceRecheck = "passed"; },
      (candidate) => { candidate.selectedReview.prospectLabel = "operator-reviewed-defer"; },
      (candidate) => { candidate.reviewSet.push(structuredClone(candidate.reviewSet[0])); },
      (candidate) => { candidate.extra = true; },
      (candidate) => { delete candidate.reviewSetCompleteness; },
    ];
    for (const mutate of requestMutations) {
      const candidate = structuredClone(request);
      mutate(candidate);
      assert.equal(validateRequest(candidate), false);
    }
    const resultMutations: Array<(candidate: Record<string, any>) => void> = [
      (candidate) => { candidate.conflictStatus = "unresolved"; },
      (candidate) => { candidate.contact = "contacted"; },
      (candidate) => { candidate.candidateCreated = true; },
      (candidate) => { candidate.publisherConsent = "established"; },
      (candidate) => { candidate.grantReady = true; },
      (candidate) => { delete candidate.requestFileSha256; },
    ];
    for (const mutate of resultMutations) {
      const candidate = structuredClone(result) as unknown as Record<string, any>;
      mutate(candidate);
      assert.equal(validateResult(candidate), false);
    }
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("prepareSendDecisionRequest requires confirmation before controlled synthetic path checks", async () => {
  const options: PrepareSendDecisionOptions = {
    selectedReviewPath: "relative-review.json",
    expectedSelectedReviewSha256: "x",
    prospectPath: "relative-prospect.md",
    expectedProspectSha256: "x",
    draftPath: "relative-draft.md",
    expectedDraftSha256: "x",
    operatorRef: "invalid",
    preparedOn: "invalid",
    humanRelatedReviewSetConfirmed: false,
    outputPath: "relative-output.json",
  };
  await assert.rejects(
    () => prepareSendDecisionRequest(options),
    (error: unknown) =>
      error instanceof SendDecisionPreparationError &&
      error.message === "Explicit related review set confirmation is required",
  );
});

test("prepareSendDecisionRequest rejects mutated controlled synthetic Phase 2L receipts without output", async () => {
  const value = await controlledSyntheticFixture("receipt-mutation");
  try {
    const review = JSON.parse(await readFile(value.reviewPath, "utf8")) as Record<string, any>;
    review.claimStatus = "operator-prepared-unattested";
    const { integritySha256: _integritySha256, ...core } = review;
    review.integritySha256 = sha256Value(core);
    const bytes = Buffer.from(JSON.stringify(review, null, 2) + "\n", "utf8");
    await writeFile(value.reviewPath, bytes, { mode: 0o600 });
    await chmod(value.reviewPath, 0o600);
    const options = await requestOptions(value);
    await assert.rejects(
      () => prepareSendDecisionRequest(options, preparationDependencies),
      /not a valid integrity-checked Phase 2L receipt/,
    );
    await assert.rejects(() => lstat(value.outputPath), { code: "ENOENT" });
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("prepareSendDecisionRequest refuses controlled synthetic related review ambiguity", async () => {
  const value = await controlledSyntheticFixture("related");
  try {
    const base = await requestOptions(value);
    await assert.rejects(
      () => prepareSendDecisionRequest({
        ...base,
        relatedReviewPaths: [value.reviewPath],
        expectedRelatedReviewSha256: [],
      }, preparationDependencies),
      /requires one matching expected SHA-256/,
    );
    await assert.rejects(() => lstat(value.outputPath), { code: "ENOENT" });

    await assert.rejects(
      () => prepareSendDecisionRequest({
        ...base,
        relatedReviewPaths: [value.reviewPath],
        expectedRelatedReviewSha256: [base.expectedSelectedReviewSha256],
      }, preparationDependencies),
      /duplicate paths, files, or digests/,
    );
    await assert.rejects(() => lstat(value.outputPath), { code: "ENOENT" });

    const relatedPath = path.join(value.directory, "controlled-synthetic-related-review.json");
    await recordProspectReview(
      {
        prospectPath: value.prospectPath,
        expectedProspectSha256: base.expectedProspectSha256,
        draftPath: value.draftPath,
        expectedDraftSha256: base.expectedDraftSha256,
        reviewerRef: REVIEWER_REF,
        reviewedOn: "2026-08-30",
        prospectLabel: "operator-reviewed-consider-outreach",
        draftLabel: "operator-reviewed-awaiting-separate-send-authorization",
        reasonCodes: ["fit-check-boundary-reviewed"],
        findings: positiveFindings(),
        humanReviewConfirmed: true,
        outputPath: relatedPath,
      },
      {
        randomUuid: () => "00000022-0000-4000-a000-000000000022",
        currentDate: () => "2026-08-31",
      },
    );
    const relatedReviewSha256 = digest(await readFile(relatedPath));
    await assert.rejects(
      () => prepareSendDecisionRequest({
        ...base,
        relatedReviewPaths: [relatedPath],
        expectedRelatedReviewSha256: [relatedReviewSha256],
      }, preparationDependencies),
      /additional related review leaves conflicts and latest status unresolved/,
    );
    await assert.rejects(() => lstat(value.outputPath), { code: "ENOENT" });
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("prepareSendDecisionRequest rejects unsafe controlled synthetic files and refuses overwrite", async () => {
  const value = await controlledSyntheticFixture("private-files");
  try {
    const base = await requestOptions(value);
    await assert.rejects(
      () => prepareSendDecisionRequest({ ...base, outputPath: "relative-request.json" }, preparationDependencies),
      /valid absolute path/,
    );
    await assert.rejects(() => lstat(value.outputPath), { code: "ENOENT" });

    await chmod(value.reviewPath, 0o644);
    await assert.rejects(
      () => prepareSendDecisionRequest(base, preparationDependencies),
      /cannot be read safely/,
    );
    await chmod(value.reviewPath, 0o600);
    await assert.rejects(() => lstat(value.outputPath), { code: "ENOENT" });

    const linkedReview = path.join(value.directory, "controlled-synthetic-linked-review.json");
    await symlink(value.reviewPath, linkedReview);
    await assert.rejects(
      () => prepareSendDecisionRequest({ ...base, selectedReviewPath: linkedReview }, preparationDependencies),
      /symbolic-link component/,
    );
    await assert.rejects(() => lstat(value.outputPath), { code: "ENOENT" });

    const hardSource = path.join(value.directory, "controlled-synthetic-hard-source.json");
    const hardReview = path.join(value.directory, "controlled-synthetic-hard-review.json");
    await writeFile(hardSource, await readFile(value.reviewPath), { mode: 0o600 });
    await link(hardSource, hardReview);
    await assert.rejects(
      () => prepareSendDecisionRequest({ ...base, selectedReviewPath: hardReview }, preparationDependencies),
      /cannot be read safely/,
    );
    await assert.rejects(() => lstat(value.outputPath), { code: "ENOENT" });

    if (process.platform !== "win32") {
      const unsafeParent = path.join(value.directory, "controlled-synthetic-public-parent");
      await mkdir(unsafeParent, { mode: 0o755 });
      await chmod(unsafeParent, 0o755);
      await assert.rejects(
        () => prepareSendDecisionRequest(
          { ...base, outputPath: path.join(unsafeParent, "request.json") },
          preparationDependencies,
        ),
        /owner-controlled and private/,
      );
      await assert.rejects(() => lstat(path.join(unsafeParent, "request.json")), { code: "ENOENT" });
    }

    await writeFile(value.outputPath, "owner data\n", { mode: 0o600 });
    await assert.rejects(
      () => prepareSendDecisionRequest(base, preparationDependencies),
      /already exists/,
    );
    assert.equal(await readFile(value.outputPath, "utf8"), "owner data\n");
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }

  const worktreeFixture = await controlledSyntheticFixture("worktree");
  try {
    const worktree = path.join(worktreeFixture.directory, "controlled-synthetic-worktree");
    const privateDirectory = path.join(worktree, "private");
    await mkdir(path.join(worktree, ".git"), { recursive: true, mode: 0o700 });
    await mkdir(privateDirectory, { mode: 0o700 });
    const outputPath = path.join(privateDirectory, "request.json");
    const worktreeOptions = await requestOptions(worktreeFixture);
    await assert.rejects(
      () => prepareSendDecisionRequest({
        ...worktreeOptions,
        outputPath,
      }, preparationDependencies),
      /outside every active Git worktree/,
    );
    await assert.rejects(() => lstat(outputPath), { code: "ENOENT" });
  } finally {
    await rm(worktreeFixture.directory, { recursive: true, force: true });
  }
});

test("prepareSendDecisionRequest detects controlled synthetic input mutation before writing", async () => {
  const value = await controlledSyntheticFixture("pre-write-mutation");
  let selectedReads = 0;
  try {
    const base = await requestOptions(value);
    await assert.rejects(
      () => prepareSendDecisionRequest(base, {
        ...preparationDependencies,
        capturePrivateInput: async (inputPath, label) => {
          const snapshot = await capturePrivateReviewInput(inputPath, label);
          if (inputPath === value.reviewPath && ++selectedReads === 1) {
            await writeFile(value.reviewPath, "{\"mutated\":true}\n", { mode: 0o600 });
            await chmod(value.reviewPath, 0o600);
          }
          return snapshot;
        },
      }),
      (error: unknown) =>
        error instanceof SendDecisionPreparationError &&
        error.exitCode === 3 &&
        /changed while/.test(error.message),
    );
    await assert.rejects(() => lstat(value.outputPath), { code: "ENOENT" });
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("prepareSendDecisionRequest detects controlled synthetic input mutation after writing", async () => {
  const value = await controlledSyntheticFixture("post-write-mutation");
  let selectedReads = 0;
  try {
    const base = await requestOptions(value);
    await assert.rejects(
      () => prepareSendDecisionRequest(base, {
        ...preparationDependencies,
        capturePrivateInput: async (inputPath, label) => {
          const snapshot = await capturePrivateReviewInput(inputPath, label);
          if (inputPath === value.reviewPath && ++selectedReads === 2) {
            await writeFile(value.reviewPath, "{\"mutated\":true}\n", { mode: 0o600 });
            await chmod(value.reviewPath, 0o600);
          }
          return snapshot;
        },
      }),
      (error: unknown) =>
        error instanceof SendDecisionPreparationError &&
        error.exitCode === 3 &&
        /mode-600 output may remain/.test(error.message),
    );
    const metadata = await lstat(value.outputPath);
    assert.ok(metadata.isFile());
    if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o600);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("send decision preparation core has no device, network, execution, or message dependency", async () => {
  const files = [
    path.join(process.cwd(), "src", "pilot", "send-decision-preparation.ts"),
    path.join(process.cwd(), "schemas", "launchrig-private-send-decision-request.schema.json"),
    path.join(process.cwd(), "schemas", "launchrig-private-send-decision-request-result.schema.json"),
  ];
  const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(
    source,
    /device\/adb|runner\/maestro|commands\/run|\.launchrig\/pilots|fetch\(|https?:\/\/(?!json-schema|launchrig\.dev\/schemas)|node:child_process|sendMessage|sendEmail/,
  );
  assert.doesNotMatch(source, /\u2014/);
  assert.doesNotMatch(source, /(?:co-)?authorship/i);
});
