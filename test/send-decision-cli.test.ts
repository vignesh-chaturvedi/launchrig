import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.js";
import {
  SendDecisionPreparationError,
  type PrepareSendDecisionOptions,
  type SendDecisionRequestResultV1,
} from "../src/pilot/send-decision-preparation.js";

const SELECTED_REVIEW_PATH = "/private/review-selected-canary.json";
const PROSPECT_PATH = "/private/prospect-canary.json";
const DRAFT_PATH = "/private/draft-canary.md";
const RELATED_REVIEW_PATHS = [
  "/private/review-related-one-canary.json",
  "/private/review-related-two-canary.json",
];
const OUTPUT_PATH = "/private/request-canary.json";
const OPERATOR_REF = "urn:launchrig:reviewer:00000000-0000-4000-a000-000000000000";

function resultFixture(): SendDecisionRequestResultV1 {
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
    requestFileSha256: "1".repeat(64),
    requestContentSha256: "2".repeat(64),
    selectedReviewFileSha256: "3".repeat(64),
    selectedReviewContentSha256: "4".repeat(64),
    prospectFileSha256: "5".repeat(64),
    draftFileSha256: "6".repeat(64),
    reviewSetCount: 1,
    reviewSetSha256: "7".repeat(64),
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
    limitations: ["Preparation does not authorize contact or dispatch a message."],
  };
}

function commandArgs(options: { json?: boolean; confirmation?: boolean; related?: boolean } = {}): string[] {
  const related = options.related === false
    ? []
    : RELATED_REVIEW_PATHS.flatMap((reviewPath, index) => [
        "--related-review",
        reviewPath,
        "--expected-related-review-sha256",
        String(index + 8).repeat(64),
      ]);
  return [
    "cohort",
    "prepare-send-decision",
    "--review",
    SELECTED_REVIEW_PATH,
    "--expected-review-sha256",
    "3".repeat(64),
    "--prospect",
    PROSPECT_PATH,
    "--expected-prospect-sha256",
    "5".repeat(64),
    "--draft",
    DRAFT_PATH,
    "--expected-draft-sha256",
    "6".repeat(64),
    ...related,
    "--operator-ref",
    OPERATOR_REF,
    "--prepared-on",
    "2026-08-31",
    ...(options.confirmation === false ? [] : ["--confirm-related-review-set-complete"]),
    "--output",
    OUTPUT_PATH,
    ...(options.json ? ["--json"] : []),
  ];
}

test("prepare-send-decision CLI passes exact explicit inputs and emits path-free JSON", async () => {
  const out: string[] = [];
  const errors: string[] = [];
  let received: PrepareSendDecisionOptions | undefined;
  const result = resultFixture();
  const exitCode = await runCli(
    commandArgs({ json: true }),
    { out: (message) => out.push(message), error: (message) => errors.push(message) },
    {
      prepareSendDecisionRequest: async (options) => {
        received = options;
        return result;
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(JSON.parse(out.join("\n")), result);
  assert.equal(received?.selectedReviewPath, SELECTED_REVIEW_PATH);
  assert.equal(received?.expectedSelectedReviewSha256, "3".repeat(64));
  assert.equal(received?.prospectPath, PROSPECT_PATH);
  assert.equal(received?.draftPath, DRAFT_PATH);
  assert.deepEqual(received?.relatedReviewPaths, RELATED_REVIEW_PATHS);
  assert.deepEqual(received?.expectedRelatedReviewSha256, ["8".repeat(64), "9".repeat(64)]);
  assert.equal(received?.operatorRef, OPERATOR_REF);
  assert.equal(received?.preparedOn, "2026-08-31");
  assert.equal(received?.humanRelatedReviewSetConfirmed, true);
  assert.equal(received?.outputPath, OUTPUT_PATH);
  assert.doesNotMatch(
    out.join("\n"),
    /review-selected-canary|review-related|prospect-canary|draft-canary|request-canary|urn:launchrig:/,
  );
});

test("prepare-send-decision human output is path-free and states that nothing was authorized or sent", async () => {
  const out: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCli(
    commandArgs({ related: false }),
    { out: (message) => out.push(message), error: (message) => errors.push(message) },
    { prepareSendDecisionRequest: async () => resultFixture() },
  );

  const rendered = out.join("\n");
  assert.equal(exitCode, 0);
  assert.deepEqual(errors, []);
  assert.match(rendered, /Private send decision request prepared/);
  assert.match(rendered, /latest status: not-established/);
  assert.match(rendered, /human send decision recorded: no/);
  assert.match(rendered, /send authorization: not-authorized/);
  assert.match(rendered, /message dispatched: no/);
  assert.match(rendered, /phone access authorized: no/);
  assert.match(rendered, /did not authorize contact or send a message/);
  assert.doesNotMatch(
    rendered,
    /review-selected-canary|prospect-canary|draft-canary|request-canary|urn:launchrig:/,
  );
});

test("prepare-send-decision passes an omitted confirmation to the core as false", async () => {
  const out: string[] = [];
  const errors: string[] = [];
  let receivedConfirmation: boolean | undefined;
  const exitCode = await runCli(
    commandArgs({ confirmation: false, related: false }),
    { out: (message) => out.push(message), error: (message) => errors.push(message) },
    {
      prepareSendDecisionRequest: async (options) => {
        receivedConfirmation = options.humanRelatedReviewSetConfirmed;
        throw new SendDecisionPreparationError(
          "Explicit related review set confirmation is required",
        );
      },
    },
  );

  assert.equal(exitCode, 2);
  assert.equal(receivedConfirmation, false);
  assert.deepEqual(out, []);
  assert.match(errors.join("\n"), /Explicit related review set confirmation is required/);
  assert.doesNotMatch(
    errors.join("\n"),
    /review-selected-canary|prospect-canary|draft-canary|request-canary|urn:launchrig:/,
  );
});

test("prepare-send-decision rejects unrelated, authorization, send, latest, force, device, project, and contact flags", async () => {
  const cases: Array<[string, string[]]> = [
    ["--pilot", ["--pilot", "unrelated-canary"]],
    ["--authorize", ["--authorize"]],
    ["--send", ["--send"]],
    ["--latest", ["--latest"]],
    ["--force", ["--force"]],
    ["--device", ["--device", "phone-canary"]],
    ["--project", ["--project", "project-canary"]],
    ["--contact", ["--contact", "contact-canary"]],
  ];
  for (const [option, addition] of cases) {
    const out: string[] = [];
    const errors: string[] = [];
    const exitCode = await runCli(
      [...commandArgs({ related: false }), ...addition],
      { out: (message) => out.push(message), error: (message) => errors.push(message) },
      { prepareSendDecisionRequest: async () => { throw new Error("must not be called"); } },
    );
    assert.equal(exitCode, 2);
    assert.deepEqual(out, []);
    assert.match(errors.join("\n"), new RegExp("does not accept " + option));
    assert.doesNotMatch(
      errors.join("\n"),
      /unrelated-canary|phone-canary|project-canary|contact-canary|review-selected-canary|request-canary/,
    );
  }
});

test("prepare-send-decision requires related review paths and hashes in pairs", async () => {
  const args = commandArgs({ related: false });
  args.push("--related-review", RELATED_REVIEW_PATHS[0]!);
  const out: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCli(args, {
    out: (message) => out.push(message),
    error: (message) => errors.push(message),
  });

  assert.equal(exitCode, 2);
  assert.deepEqual(out, []);
  assert.match(errors.join("\n"), /one --expected-related-review-sha256 for every --related-review/);
  assert.doesNotMatch(errors.join("\n"), /review-related-one-canary|request-canary/);
});
