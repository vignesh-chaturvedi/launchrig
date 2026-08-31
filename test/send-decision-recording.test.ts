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
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  capturePrivateReviewInput,
  recordProspectReview,
  type ProspectReviewFindings,
} from "../src/pilot/prospect-review.js";
import {
  prepareSendDecisionRequest,
  parsePrivateSendDecisionRequestV1,
  sendDecisionReviewSetSha256,
} from "../src/pilot/send-decision-preparation.js";
import {
  HumanSendDecisionError,
  recordHumanSendDecision,
  type RecordHumanSendDecisionOptions,
} from "../src/pilot/send-decision-recording.js";
import { sha256Value } from "../src/pilot/store.js";

const REVIEWER_REF = "urn:launchrig:reviewer:00000001-0000-4000-a000-000000000001";
const AUTHORIZER_REF = "urn:launchrig:reviewer:00000002-0000-4000-a000-000000000002";
const REVIEW_UUID = "00000003-0000-4000-a000-000000000003";
const DECISION_UUID = "00000004-0000-4000-a000-000000000004";
const TODAY = "2026-09-01";

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const positiveFindings = (): ProspectReviewFindings => ({
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
});

interface ControlledFixture {
  directory: string;
  prospectPath: string;
  draftPath: string;
  reviewPath: string;
  requestPath: string;
  prospectBytes: Buffer;
  draftBytes: Buffer;
  reviewBytes: Buffer;
  requestBytes: Buffer;
}

async function controlledFixture(name: string): Promise<ControlledFixture> {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "launchrig-human-send-" + name + "-")),
  );
  await chmod(directory, 0o700);
  const prospectPath = path.join(directory, "controlled-synthetic-prospect.md");
  const draftPath = path.join(directory, "controlled-synthetic-draft.md");
  const reviewPath = path.join(directory, "controlled-synthetic-review.json");
  const requestPath = path.join(directory, "controlled-synthetic-request.json");
  const prospectBytes = Buffer.from(
    "# Controlled synthetic prospect\n\nSynthetic public fact for a local test only.\n",
    "utf8",
  );
  const draftBytes = Buffer.from(
    "# Controlled synthetic draft\n\nWould you be open to a short fit check?\n",
    "utf8",
  );
  await writeFile(prospectPath, prospectBytes, { mode: 0o600 });
  await writeFile(draftPath, draftBytes, { mode: 0o600 });
  await chmod(prospectPath, 0o600);
  await chmod(draftPath, 0o600);

  await recordProspectReview(
    {
      prospectPath,
      expectedProspectSha256: digest(prospectBytes),
      draftPath,
      expectedDraftSha256: digest(draftBytes),
      reviewerRef: REVIEWER_REF,
      reviewedOn: TODAY,
      prospectLabel: "operator-reviewed-consider-outreach",
      draftLabel: "operator-reviewed-awaiting-separate-send-authorization",
      reasonCodes: ["fit-check-boundary-reviewed"],
      findings: positiveFindings(),
      humanReviewConfirmed: true,
      outputPath: reviewPath,
    },
    {
      randomUuid: () => REVIEW_UUID,
      currentDate: () => TODAY,
    },
  );
  const reviewBytes = await readFile(reviewPath);

  await prepareSendDecisionRequest(
    {
      selectedReviewPath: reviewPath,
      expectedSelectedReviewSha256: digest(reviewBytes),
      prospectPath,
      expectedProspectSha256: digest(prospectBytes),
      draftPath,
      expectedDraftSha256: digest(draftBytes),
      operatorRef: REVIEWER_REF,
      preparedOn: TODAY,
      humanRelatedReviewSetConfirmed: true,
      outputPath: requestPath,
    },
    { currentDate: () => TODAY },
  );
  const requestBytes = await readFile(requestPath);
  return {
    directory,
    prospectPath,
    draftPath,
    reviewPath,
    requestPath,
    prospectBytes,
    draftBytes,
    reviewBytes,
    requestBytes,
  };
}

function positiveOptions(
  value: ControlledFixture,
  outputName = "controlled-synthetic-decision.json",
): RecordHumanSendDecisionOptions {
  return {
    requestPath: value.requestPath,
    expectedRequestSha256: digest(value.requestBytes),
    reviewPath: value.reviewPath,
    expectedReviewSha256: digest(value.reviewBytes),
    prospectPath: value.prospectPath,
    expectedProspectSha256: digest(value.prospectBytes),
    draftPath: value.draftPath,
    expectedDraftSha256: digest(value.draftBytes),
    authorizerRef: AUTHORIZER_REF,
    decidedOn: TODAY,
    decision: "authorize-exact-reviewed-draft",
    reasonCodes: ["exact-fit-check-send-authorized"],
    sourceRecheck: "reopened-and-fact-confirmed",
    routeRecheck: "appropriate",
    relationshipDisclosureRecheck: "complete-or-not-applicable",
    compensationDisclosureRecheck: "complete-or-not-applicable",
    safetyRecheck: "fit-check-only-boundaries-confirmed",
    authorizationExpiresOn: "2026-09-02",
    humanSendDecisionConfirmed: true,
    outputPath: path.join(value.directory, outputName),
  };
}

const recordingDependencies = {
  randomUuid: () => DECISION_UUID,
  currentDate: () => TODAY,
};

async function compileDecisionSchemas(): Promise<{
  validateDecision: ReturnType<Ajv2020["compile"]>;
  validateResult: ReturnType<Ajv2020["compile"]>;
}> {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
  ajv.addFormat("date", /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  const decisionSchema = JSON.parse(
    await readFile(
      path.join(process.cwd(), "schemas", "launchrig-private-human-send-decision.schema.json"),
      "utf8",
    ),
  );
  const resultSchema = JSON.parse(
    await readFile(
      path.join(process.cwd(), "schemas", "launchrig-private-human-send-decision-result.schema.json"),
      "utf8",
    ),
  );
  return {
    validateDecision: ajv.compile(decisionSchema),
    validateResult: ajv.compile(resultSchema),
  };
}

test("recordHumanSendDecision creates one claim-limited positive controlled synthetic receipt", async () => {
  const value = await controlledFixture("positive");
  try {
    const options = positiveOptions(value);
    const result = await recordHumanSendDecision(options, recordingDependencies);
    const decisionBytes = await readFile(options.outputPath);
    const decision = JSON.parse(decisionBytes.toString("utf8")) as Record<string, any>;
    const metadata = await lstat(options.outputPath);

    assert.equal(result.kind, "launchrig-private-human-send-decision-result");
    assert.equal(result.decision, "authorize-exact-reviewed-draft");
    assert.equal(result.humanSendDecisionConfirmed, true);
    assert.equal(result.humanNoAdditionalRelatedReviewConfirmed, true);
    assert.equal(result.humanAuthorizerAuthenticated, false);
    assert.equal(result.reviewSetCompleteness, "operator-asserted-unattested");
    assert.equal(result.conflictStatus, "none-detected-in-operator-supplied-set");
    assert.equal(result.latestStatus, "not-established");
    assert.equal(result.reviewSetCount, 1);
    assert.equal(result.sendAuthorization, "authorized-for-one-exact-manual-fit-check-send");
    assert.equal(result.authorizationScope, "one-manual-send-of-exact-reviewed-draft");
    assert.equal(result.authorizationExpiresOn, "2026-09-02");
    assert.equal(result.contact, "not-contacted");
    assert.equal(result.messageDispatched, false);
    assert.equal(result.candidateCreated, false);
    assert.equal(result.interestRecorded, false);
    assert.equal(result.projectModificationAuthorized, false);
    assert.equal(result.phoneAccessAuthorized, false);
    assert.equal(result.pilotStateChecked, false);
    assert.equal(result.deviceEnvironmentChecked, false);
    assert.equal(result.publisherConsent, "not-established");
    assert.equal(result.grantReady, false);
    assert.equal(result.decisionFileSha256, digest(decisionBytes));
    assert.equal(result.decisionContentSha256, decision.integritySha256);

    assert.equal(decision.kind, "launchrig-private-human-send-decision");
    assert.equal(decision.decisionRef, "urn:launchrig:send-decision:" + DECISION_UUID);
    assert.equal(decision.authorizerRef, AUTHORIZER_REF);
    assert.equal(decision.reviewSetCount, 1);
    assert.equal(decision.request.fileSha256, digest(value.requestBytes));
    assert.equal(decision.review.fileSha256, digest(value.reviewBytes));
    assert.equal(decision.prospect.fileSha256, digest(value.prospectBytes));
    assert.equal(decision.draft.fileSha256, digest(value.draftBytes));
    const { integritySha256: _integritySha256, ...core } = decision;
    assert.equal(decision.integritySha256, sha256Value(core));

    assert.ok(metadata.isFile());
    assert.equal(metadata.nlink, 1);
    if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o600);
    if (typeof process.getuid === "function") assert.equal(metadata.uid, process.getuid());

    const publicResult = JSON.stringify(result);
    assert.doesNotMatch(publicResult, /urn:launchrig:/);
    assert.doesNotMatch(publicResult, /controlled-synthetic/);
    assert.doesNotMatch(
      publicResult,
      new RegExp(value.directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );

    const { validateDecision, validateResult } = await compileDecisionSchemas();
    assert.equal(validateDecision(decision), true, JSON.stringify(validateDecision.errors));
    assert.equal(validateResult(result), true, JSON.stringify(validateResult.errors));
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("recordHumanSendDecision accepts the three nonpositive controlled synthetic outcomes", async () => {
  const value = await controlledFixture("nonpositive");
  try {
    const cases: Array<{
      name: string;
      decision: RecordHumanSendDecisionOptions["decision"];
      reasonCodes: readonly string[];
    }> = [
      {
        name: "revision",
        decision: "require-revision",
        reasonCodes: ["draft-revision-required"],
      },
      {
        name: "defer",
        decision: "defer",
        reasonCodes: ["timing-deferred"],
      },
      {
        name: "do-not-send",
        decision: "do-not-send",
        reasonCodes: ["operator-do-not-send"],
      },
    ];
    const { validateDecision, validateResult } = await compileDecisionSchemas();
    for (const entry of cases) {
      const options: RecordHumanSendDecisionOptions = {
        ...positiveOptions(value, "controlled-synthetic-" + entry.name + ".json"),
        decision: entry.decision,
        reasonCodes: entry.reasonCodes,
        authorizationExpiresOn: null,
      };
      const result = await recordHumanSendDecision(options, recordingDependencies);
      const decision = JSON.parse(await readFile(options.outputPath, "utf8"));
      assert.equal(result.decision, entry.decision);
      assert.equal(result.sendAuthorization, "not-authorized");
      assert.equal(result.authorizationScope, "none");
      assert.equal(result.authorizationExpiresOn, null);
      assert.equal(result.contact, "not-contacted");
      assert.equal(result.messageDispatched, false);
      assert.equal(validateDecision(decision), true, JSON.stringify(validateDecision.errors));
      assert.equal(validateResult(result), true, JSON.stringify(validateResult.errors));
    }
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("recordHumanSendDecision enforces the strict controlled synthetic decision matrix", async () => {
  const value = await controlledFixture("matrix");
  try {
    const base = positiveOptions(value);
    const cases: Array<{ name: string; patch: Partial<RecordHumanSendDecisionOptions> }> = [
      {
        name: "positive stale date",
        patch: { decidedOn: "2026-08-31", authorizationExpiresOn: "2026-08-31" },
      },
      {
        name: "positive expiry too late",
        patch: { authorizationExpiresOn: "2026-09-03" },
      },
      {
        name: "positive incomplete safety",
        patch: { safetyRecheck: "incomplete-or-unsafe" },
      },
      {
        name: "revision without revision reason",
        patch: { decision: "require-revision", reasonCodes: ["timing-deferred"], authorizationExpiresOn: null },
      },
      {
        name: "defer without timing reason",
        patch: { decision: "defer", reasonCodes: ["draft-revision-required"], authorizationExpiresOn: null },
      },
      {
        name: "do not send without terminal reason",
        patch: { decision: "do-not-send", reasonCodes: ["source-recheck-incomplete"], authorizationExpiresOn: null },
      },
      {
        name: "nonpositive expiry",
        patch: { decision: "defer", reasonCodes: ["timing-deferred"] },
      },
      {
        name: "source reason mismatch",
        patch: { decision: "defer", reasonCodes: ["timing-deferred", "source-recheck-incomplete"], authorizationExpiresOn: null },
      },
      {
        name: "reason order",
        patch: {
          decision: "defer",
          sourceRecheck: "incomplete-or-stale",
          reasonCodes: ["source-recheck-incomplete", "timing-deferred"],
          authorizationExpiresOn: null,
        },
      },
    ];
    for (const [index, entry] of cases.entries()) {
      const outputPath = path.join(value.directory, "controlled-synthetic-invalid-" + String(index) + ".json");
      await assert.rejects(
        () => recordHumanSendDecision({ ...base, ...entry.patch, outputPath }, recordingDependencies),
        HumanSendDecisionError,
        entry.name,
      );
      await assert.rejects(() => lstat(outputPath), { code: "ENOENT" });
    }
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("recordHumanSendDecision requires confirmation before controlled synthetic path checks", async () => {
  const options: RecordHumanSendDecisionOptions = {
    requestPath: "relative-request.json",
    expectedRequestSha256: "x",
    reviewPath: "relative-review.json",
    expectedReviewSha256: "x",
    prospectPath: "relative-prospect.md",
    expectedProspectSha256: "x",
    draftPath: "relative-draft.md",
    expectedDraftSha256: "x",
    authorizerRef: "invalid",
    decidedOn: "invalid",
    decision: "invalid",
    reasonCodes: [],
    sourceRecheck: "invalid",
    routeRecheck: "invalid",
    relationshipDisclosureRecheck: "invalid",
    compensationDisclosureRecheck: "invalid",
    safetyRecheck: "invalid",
    humanSendDecisionConfirmed: false,
    outputPath: "relative-output.json",
  };
  await assert.rejects(
    () => recordHumanSendDecision(options),
    (error: unknown) =>
      error instanceof HumanSendDecisionError &&
      error.message === "Explicit human send decision confirmation is required",
  );
});

test("recordHumanSendDecision rejects mutated and unrelated controlled synthetic inputs", async () => {
  const value = await controlledFixture("bindings");
  try {
    const request = JSON.parse(value.requestBytes.toString("utf8")) as Record<string, any>;
    request.claimStatus = "human-operator-recorded-unattested";
    const { integritySha256: _integritySha256, ...core } = request;
    request.integritySha256 = sha256Value(core);
    const mutatedRequestBytes = Buffer.from(JSON.stringify(request, null, 2) + "\n", "utf8");
    await writeFile(value.requestPath, mutatedRequestBytes, { mode: 0o600 });
    await chmod(value.requestPath, 0o600);
    const outputPath = path.join(value.directory, "controlled-synthetic-mutated-output.json");
    await assert.rejects(
      () => recordHumanSendDecision(
        {
          ...positiveOptions(value),
          expectedRequestSha256: digest(mutatedRequestBytes),
          outputPath,
        },
        recordingDependencies,
      ),
      /not valid and integrity checked/,
    );
    await assert.rejects(() => lstat(outputPath), { code: "ENOENT" });

    const duplicateRequestBytes = Buffer.from(
      value.requestBytes.toString("utf8").replace(
        '  "kind": "launchrig-private-send-decision-request",\n',
        '  "kind": "launchrig-private-send-decision-request",\n  "kind": "launchrig-private-send-decision-request",\n',
      ),
      "utf8",
    );
    await writeFile(value.requestPath, duplicateRequestBytes, { mode: 0o600 });
    await chmod(value.requestPath, 0o600);
    const duplicateOutputPath = path.join(
      value.directory,
      "controlled-synthetic-duplicate-output.json",
    );
    await assert.rejects(
      () => recordHumanSendDecision(
        {
          ...positiveOptions(value),
          expectedRequestSha256: digest(duplicateRequestBytes),
          outputPath: duplicateOutputPath,
        },
        recordingDependencies,
      ),
      /strict JSON without duplicate keys/,
    );
    await assert.rejects(() => lstat(duplicateOutputPath), { code: "ENOENT" });
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("strict Phase 2M request parser rejects controlled synthetic cross-field mutations", async () => {
  const value = await controlledFixture("request-parser");
  try {
    const source = JSON.parse(value.requestBytes.toString("utf8")) as Record<string, any>;
    assert.equal(parsePrivateSendDecisionRequestV1(source).kind, "launchrig-private-send-decision-request");

    const cases: Array<(candidate: Record<string, any>) => void> = [
      (candidate) => {
        candidate.selectedReview.reviewedOn = "2026-09-02";
        candidate.reviewSet[0].reviewedOn = "2026-09-02";
      },
      (candidate) => {
        candidate.prospect.fileSha256 = candidate.draft.fileSha256;
        candidate.selectedReview.prospectFileSha256 = candidate.draft.fileSha256;
        candidate.reviewSet[0].prospectFileSha256 = candidate.draft.fileSha256;
      },
      (candidate) => {
        candidate.selectedReview.reviewRef = "urn:launchrig:prospect-review:00000005-0000-4000-a000-000000000005";
      },
      (candidate) => {
        candidate.extra = true;
      },
    ];
    for (const mutate of cases) {
      const candidate = structuredClone(source);
      mutate(candidate);
      if (!candidate.extra) {
        candidate.reviewSetSha256 = sendDecisionReviewSetSha256(candidate.reviewSet);
      }
      const { integritySha256: _integritySha256, ...core } = candidate;
      candidate.integritySha256 = sha256Value(core);
      assert.throws(() => parsePrivateSendDecisionRequestV1(candidate));
    }
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("recordHumanSendDecision enforces private no-follow inputs and no-overwrite output", async () => {
  const value = await controlledFixture("private-files");
  try {
    const hardlinkPath = path.join(value.directory, "controlled-synthetic-prospect-hardlink.md");
    await link(value.prospectPath, hardlinkPath);
    await assert.rejects(
      () => recordHumanSendDecision(
        {
          ...positiveOptions(value),
          outputPath: path.join(value.directory, "controlled-synthetic-hardlink-output.json"),
        },
        recordingDependencies,
      ),
      /cannot be read safely/,
    );
    await rm(hardlinkPath);

    const existingOutput = path.join(value.directory, "controlled-synthetic-existing.json");
    await writeFile(existingOutput, "preserve\n", { mode: 0o600 });
    await chmod(existingOutput, 0o600);
    await assert.rejects(
      () => recordHumanSendDecision(
        { ...positiveOptions(value), outputPath: existingOutput },
        recordingDependencies,
      ),
      /output already exists/,
    );
    assert.equal(await readFile(existingOutput, "utf8"), "preserve\n");

    if (process.platform !== "win32") {
      const publicDirectory = path.join(value.directory, "public-output-parent");
      await mkdir(publicDirectory, { mode: 0o755 });
      await chmod(publicDirectory, 0o755);
      await assert.rejects(
        () => recordHumanSendDecision(
          {
            ...positiveOptions(value),
            outputPath: path.join(publicDirectory, "controlled-synthetic-output.json"),
          },
          recordingDependencies,
        ),
        /owner-controlled and private/,
      );
    }

    const worktree = path.join(value.directory, "controlled-synthetic-worktree");
    const worktreePrivateDirectory = path.join(worktree, "private");
    await mkdir(path.join(worktree, ".git"), { recursive: true, mode: 0o700 });
    await mkdir(worktreePrivateDirectory, { mode: 0o700 });
    await assert.rejects(
      () => recordHumanSendDecision(
        {
          ...positiveOptions(value),
          outputPath: path.join(worktreePrivateDirectory, "controlled-synthetic-output.json"),
        },
        recordingDependencies,
      ),
      /outside every active Git worktree/,
    );
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("recordHumanSendDecision detects controlled synthetic input mutation before writing", async () => {
  const value = await controlledFixture("pre-write-mutation");
  let reviewReads = 0;
  const outputPath = path.join(value.directory, "controlled-synthetic-pre-write-output.json");
  try {
    await assert.rejects(
      () => recordHumanSendDecision(
        { ...positiveOptions(value), outputPath },
        {
          ...recordingDependencies,
          capturePrivateInput: async (inputPath, label) => {
            const snapshot = await capturePrivateReviewInput(inputPath, label);
            if (inputPath === value.reviewPath && ++reviewReads === 1) {
              await writeFile(value.reviewPath, "{\"mutated\":true}\n", { mode: 0o600 });
              await chmod(value.reviewPath, 0o600);
            }
            return snapshot;
          },
        },
      ),
      (error: unknown) =>
        error instanceof HumanSendDecisionError &&
        error.exitCode === 3 &&
        /changed while/.test(error.message),
    );
    await assert.rejects(() => lstat(outputPath), { code: "ENOENT" });
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("recordHumanSendDecision detects controlled synthetic input mutation after writing", async () => {
  const value = await controlledFixture("post-write-mutation");
  let reviewReads = 0;
  const outputPath = path.join(value.directory, "controlled-synthetic-post-write-output.json");
  try {
    await assert.rejects(
      () => recordHumanSendDecision(
        { ...positiveOptions(value), outputPath },
        {
          ...recordingDependencies,
          capturePrivateInput: async (inputPath, label) => {
            const snapshot = await capturePrivateReviewInput(inputPath, label);
            if (inputPath === value.reviewPath && ++reviewReads === 2) {
              await writeFile(value.reviewPath, "{\"mutated\":true}\n", { mode: 0o600 });
              await chmod(value.reviewPath, 0o600);
            }
            return snapshot;
          },
        },
      ),
      (error: unknown) =>
        error instanceof HumanSendDecisionError &&
        error.exitCode === 3 &&
        /mode-600 output may remain/.test(error.message),
    );
    const metadata = await lstat(outputPath);
    assert.ok(metadata.isFile());
    if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o600);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("human send decision core has no device, network, execution, or message dependency", async () => {
  const files = [
    path.join(process.cwd(), "src", "pilot", "send-decision-recording.ts"),
    path.join(process.cwd(), "schemas", "launchrig-private-human-send-decision.schema.json"),
    path.join(process.cwd(), "schemas", "launchrig-private-human-send-decision-result.schema.json"),
  ];
  const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(
    source,
    /device\/adb|runner\/maestro|commands\/run|\.launchrig\/pilots|fetch\(|https?:\/\/(?!json-schema|launchrig\.dev\/schemas)|node:child_process|sendMessage|sendEmail/,
  );
  assert.doesNotMatch(source, /\u2014/);
  assert.doesNotMatch(source, /(?:co-)?authorship/i);
});
