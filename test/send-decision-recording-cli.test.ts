import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.js";
import {
  HumanSendDecisionError,
  type HumanSendDecisionResultV1,
  type RecordHumanSendDecisionOptions,
} from "../src/pilot/send-decision-recording.js";

const REQUEST_PATH = "/private/request-canary.json";
const REVIEW_PATH = "/private/review-canary.json";
const PROSPECT_PATH = "/private/prospect-canary.md";
const DRAFT_PATH = "/private/draft-canary.md";
const OUTPUT_PATH = "/private/decision-canary.json";
const AUTHORIZER_REF = "urn:launchrig:reviewer:00000031-0000-4000-a000-000000000031";

function resultFixture(): HumanSendDecisionResultV1 {
  return {
    schemaVersion: 1,
    kind: "launchrig-private-human-send-decision-result",
    profile: "phase-2n-human-send-decision-v1",
    status: "created",
    claimStatus: "human-operator-recorded-unattested",
    humanSendDecisionConfirmed: true,
    humanNoAdditionalRelatedReviewConfirmed: true,
    humanAuthorizerAuthenticated: false,
    decisionFileSha256: "1".repeat(64),
    decisionContentSha256: "2".repeat(64),
    requestFileSha256: "3".repeat(64),
    requestContentSha256: "4".repeat(64),
    reviewFileSha256: "5".repeat(64),
    reviewContentSha256: "6".repeat(64),
    prospectFileSha256: "7".repeat(64),
    draftFileSha256: "8".repeat(64),
    reviewSetCount: 1,
    reviewSetSha256: "9".repeat(64),
    reviewSetCompleteness: "operator-asserted-unattested",
    conflictStatus: "none-detected-in-operator-supplied-set",
    latestStatus: "not-established",
    decision: "authorize-exact-reviewed-draft",
    reasonCodes: ["exact-fit-check-send-authorized"],
    sourceRecheck: "reopened-and-fact-confirmed",
    routeRecheck: "appropriate",
    relationshipDisclosureRecheck: "complete-or-not-applicable",
    compensationDisclosureRecheck: "complete-or-not-applicable",
    safetyRecheck: "fit-check-only-boundaries-confirmed",
    sendAuthorization: "authorized-for-one-exact-manual-fit-check-send",
    authorizationScope: "one-manual-send-of-exact-reviewed-draft",
    authorizationExpiresOn: "2026-09-02",
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
    limitations: ["The recorder contacts nobody and dispatches no message."],
  };
}

function commandArgs(options: { json?: boolean; confirmation?: boolean } = {}): string[] {
  return [
    "cohort",
    "record-send-decision",
    "--request",
    REQUEST_PATH,
    "--expected-request-sha256",
    "3".repeat(64),
    "--review",
    REVIEW_PATH,
    "--expected-review-sha256",
    "5".repeat(64),
    "--prospect",
    PROSPECT_PATH,
    "--expected-prospect-sha256",
    "7".repeat(64),
    "--draft",
    DRAFT_PATH,
    "--expected-draft-sha256",
    "8".repeat(64),
    "--authorizer-ref",
    AUTHORIZER_REF,
    "--decided-on",
    "2026-09-01",
    "--decision",
    "authorize-exact-reviewed-draft",
    "--reason-code",
    "exact-fit-check-send-authorized",
    "--source-recheck",
    "reopened-and-fact-confirmed",
    "--route-recheck",
    "appropriate",
    "--relationship-disclosure-recheck",
    "complete-or-not-applicable",
    "--compensation-disclosure-recheck",
    "complete-or-not-applicable",
    "--safety-recheck",
    "fit-check-only-boundaries-confirmed",
    "--authorization-expires-on",
    "2026-09-02",
    ...(options.confirmation === false ? [] : ["--confirm-human-send-decision"]),
    "--output",
    OUTPUT_PATH,
    ...(options.json ? ["--json"] : []),
  ];
}

test("record-send-decision CLI passes exact explicit inputs and emits path-free JSON", async () => {
  const out: string[] = [];
  const errors: string[] = [];
  let received: RecordHumanSendDecisionOptions | undefined;
  const result = resultFixture();
  const exitCode = await runCli(
    commandArgs({ json: true }),
    { out: (message) => out.push(message), error: (message) => errors.push(message) },
    {
      recordHumanSendDecision: async (options) => {
        received = options;
        return result;
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(JSON.parse(out.join("\n")), result);
  assert.equal(received?.requestPath, REQUEST_PATH);
  assert.equal(received?.expectedRequestSha256, "3".repeat(64));
  assert.equal(received?.reviewPath, REVIEW_PATH);
  assert.equal(received?.expectedReviewSha256, "5".repeat(64));
  assert.equal(received?.prospectPath, PROSPECT_PATH);
  assert.equal(received?.draftPath, DRAFT_PATH);
  assert.equal(received?.authorizerRef, AUTHORIZER_REF);
  assert.equal(received?.decidedOn, "2026-09-01");
  assert.equal(received?.decision, "authorize-exact-reviewed-draft");
  assert.deepEqual(received?.reasonCodes, ["exact-fit-check-send-authorized"]);
  assert.equal(received?.humanSendDecisionConfirmed, true);
  assert.equal(received?.outputPath, OUTPUT_PATH);
  assert.doesNotMatch(
    out.join("\n"),
    /request-canary|review-canary|prospect-canary|draft-canary|decision-canary|urn:launchrig:/,
  );
});

test("record-send-decision human output separates authorization from contact and dispatch", async () => {
  const out: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCli(
    commandArgs(),
    { out: (message) => out.push(message), error: (message) => errors.push(message) },
    { recordHumanSendDecision: async () => resultFixture() },
  );

  const rendered = out.join("\n");
  assert.equal(exitCode, 0);
  assert.deepEqual(errors, []);
  assert.match(rendered, /Private human send decision receipt created/);
  assert.match(rendered, /decision: authorize-exact-reviewed-draft/);
  assert.match(rendered, /send authorization: authorized-for-one-exact-manual-fit-check-send/);
  assert.match(rendered, /contact: not-contacted/);
  assert.match(rendered, /message dispatched: no/);
  assert.match(rendered, /phone access authorized: no/);
  assert.match(rendered, /contacted nobody and dispatched nothing/);
  assert.doesNotMatch(
    rendered,
    /request-canary|review-canary|prospect-canary|draft-canary|decision-canary|urn:launchrig:/,
  );
});

test("record-send-decision passes omitted confirmation to the core as false", async () => {
  const out: string[] = [];
  const errors: string[] = [];
  let receivedConfirmation: boolean | undefined;
  const exitCode = await runCli(
    commandArgs({ confirmation: false }),
    { out: (message) => out.push(message), error: (message) => errors.push(message) },
    {
      recordHumanSendDecision: async (options) => {
        receivedConfirmation = options.humanSendDecisionConfirmed;
        throw new HumanSendDecisionError("Explicit human send decision confirmation is required");
      },
    },
  );

  assert.equal(exitCode, 2);
  assert.equal(receivedConfirmation, false);
  assert.deepEqual(out, []);
  assert.match(errors.join("\n"), /Explicit human send decision confirmation is required/);
  assert.doesNotMatch(
    errors.join("\n"),
    /request-canary|review-canary|prospect-canary|draft-canary|decision-canary|urn:launchrig:/,
  );
});

test("record-send-decision rejects transport, execution, device, project, and contact flags", async () => {
  const cases: Array<[string, string[]]> = [
    ["--authorize", ["--authorize"]],
    ["--send", ["--send"]],
    ["--dispatch", ["--dispatch"]],
    ["--message", ["--message", "message-canary"]],
    ["--latest", ["--latest"]],
    ["--force", ["--force"]],
    ["--device", ["--device", "phone-canary"]],
    ["--adb", ["--adb", "adb-canary"]],
    ["--maestro", ["--maestro", "maestro-canary"]],
    ["--project", ["--project", "project-canary"]],
    ["--contact", ["--contact", "contact-canary"]],
  ];
  for (const [option, addition] of cases) {
    const out: string[] = [];
    const errors: string[] = [];
    const exitCode = await runCli(
      [...commandArgs(), ...addition],
      { out: (message) => out.push(message), error: (message) => errors.push(message) },
      { recordHumanSendDecision: async () => { throw new Error("must not be called"); } },
    );
    assert.equal(exitCode, 2);
    assert.deepEqual(out, []);
    assert.match(errors.join("\n"), new RegExp("does not accept " + option));
    assert.doesNotMatch(
      errors.join("\n"),
      /message-canary|phone-canary|adb-canary|maestro-canary|project-canary|contact-canary|request-canary/,
    );
  }
});
