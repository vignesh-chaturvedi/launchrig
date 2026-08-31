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
import { runCli } from "../src/cli.js";
import {
  capturePrivateReviewInput,
  type ProspectReviewFindings,
  ProspectReviewError,
  type ProspectReviewResultV1,
  recordProspectReview,
  type RecordProspectReviewOptions,
} from "../src/pilot/prospect-review.js";
import { sha256Value } from "../src/pilot/store.js";

const REVIEWER_REF = "urn:launchrig:reviewer:00000001-0000-4000-a000-000000000001";
const REVIEW_UUID = "00000002-0000-4000-a000-000000000002";

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

interface ReviewFixture {
  directory: string;
  prospectPath: string;
  draftPath: string;
  outputPath: string;
  prospectBytes: Buffer;
  draftBytes: Buffer;
}

async function fixture(name: string): Promise<ReviewFixture> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "launchrig-review-" + name + "-")));
  const prospectPath = path.join(directory, "prospect.md");
  const draftPath = path.join(directory, "draft.md");
  const outputPath = path.join(directory, "review.json");
  const prospectBytes = Buffer.from("# Exact prospect\n\nOne reviewed public fact.\n", "utf8");
  const draftBytes = Buffer.from("# Exact draft\n\nWould you be open to a short fit check?\n", "utf8");
  await writeFile(prospectPath, prospectBytes, { mode: 0o600 });
  await writeFile(draftPath, draftBytes, { mode: 0o600 });
  await chmod(prospectPath, 0o600);
  await chmod(draftPath, 0o600);
  return { directory, prospectPath, draftPath, outputPath, prospectBytes, draftBytes };
}

function options(value: ReviewFixture): RecordProspectReviewOptions {
  return {
    prospectPath: value.prospectPath,
    expectedProspectSha256: digest(value.prospectBytes),
    draftPath: value.draftPath,
    expectedDraftSha256: digest(value.draftBytes),
    reviewerRef: REVIEWER_REF,
    reviewedOn: "2026-08-31",
    prospectLabel: "operator-reviewed-consider-outreach",
    draftLabel: "operator-reviewed-awaiting-separate-send-authorization",
    reasonCodes: ["fit-check-boundary-reviewed"],
    findings: positiveFindings(),
    humanReviewConfirmed: true,
    outputPath: value.outputPath,
  };
}

function resultFixture(): ProspectReviewResultV1 {
  return {
    schemaVersion: 1,
    kind: "launchrig-private-prospect-review-result",
    profile: "phase-2l-human-prospect-review-v1",
    status: "created",
    claimStatus: "human-operator-recorded-unattested",
    humanReviewConfirmed: true,
    humanReviewerAuthenticated: false,
    reviewFileSha256: "1".repeat(64),
    reviewContentSha256: "2".repeat(64),
    prospectFileSha256: "3".repeat(64),
    draftFileSha256: "4".repeat(64),
    prospectLabel: "operator-reviewed-consider-outreach",
    draftLabel: "operator-reviewed-awaiting-separate-send-authorization",
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
    limitations: ["Private operator assertion only."],
  };
}

function findingArgs(findings: ProspectReviewFindings): string[] {
  return Object.entries(findings).flatMap(([key, value]) => ["--finding", key + "=" + value]);
}

const dependencies = {
  randomUuid: () => REVIEW_UUID,
  currentDate: () => "2026-08-31",
};

test("recordProspectReview binds exact private bytes without authorizing contact or a device", async () => {
  const value = await fixture("create");
  try {
    const result = await recordProspectReview(options(value), dependencies);
    const reviewBytes = await readFile(value.outputPath);
    const review = JSON.parse(reviewBytes.toString("utf8")) as Record<string, any>;
    const metadata = await lstat(value.outputPath);

    assert.equal(result.kind, "launchrig-private-prospect-review-result");
    assert.equal(result.claimStatus, "human-operator-recorded-unattested");
    assert.equal(result.humanReviewConfirmed, true);
    assert.equal(result.humanReviewerAuthenticated, false);
    assert.equal(result.reviewFileSha256, digest(reviewBytes));
    assert.equal(result.reviewContentSha256, review.integritySha256);
    assert.equal(result.prospectFileSha256, digest(value.prospectBytes));
    assert.equal(result.draftFileSha256, digest(value.draftBytes));
    assert.equal(result.contact, "not-contacted");
    assert.equal(result.sendAuthorization, "not-authorized");
    assert.equal(result.lifecycle, "screening");
    assert.equal(result.candidateCreated, false);
    assert.equal(result.interestRecorded, false);
    assert.equal(result.projectModificationAuthorized, false);
    assert.equal(result.phoneAccessAuthorized, false);
    assert.equal(result.pilotStateChecked, false);
    assert.equal(result.deviceEnvironmentChecked, false);
    assert.equal(result.externalGrantGate, "not-established");
    assert.equal(result.grantReady, false);

    assert.ok(metadata.isFile());
    assert.equal(metadata.nlink, 1);
    if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o600);
    if (typeof process.getuid === "function") assert.equal(metadata.uid, process.getuid());

    assert.equal(review.kind, "launchrig-private-prospect-review");
    assert.equal(review.profile, "phase-2l-human-prospect-review-v1");
    assert.equal(review.reviewRef, "urn:launchrig:prospect-review:" + REVIEW_UUID);
    assert.equal(review.reviewerRef, REVIEWER_REF);
    assert.equal(review.humanReviewConfirmed, true);
    assert.equal(review.humanReviewerAuthenticated, false);
    assert.equal(review.prospect.fileSha256, result.prospectFileSha256);
    assert.equal(review.draft.fileSha256, result.draftFileSha256);
    assert.deepEqual(review.reasonCodes, ["fit-check-boundary-reviewed"]);
    assert.deepEqual(review.findings, positiveFindings());
    const { integritySha256: _integrity, ...core } = review;
    assert.equal(review.integritySha256, sha256Value(core));

    const publicResult = JSON.stringify(result);
    assert.doesNotMatch(publicResult, /urn:launchrig:|prospect\.md|draft\.md|review\.json/);
    assert.doesNotMatch(publicResult, new RegExp(value.directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(publicResult, /Exact prospect|Exact draft|Android Device Ready|Android\/MWA Ready/);

    const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
    ajv.addFormat("date", /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    const reviewSchema = JSON.parse(
      await readFile(path.join(process.cwd(), "schemas", "launchrig-private-prospect-review.schema.json"), "utf8"),
    );
    const resultSchema = JSON.parse(
      await readFile(
        path.join(process.cwd(), "schemas", "launchrig-private-prospect-review-result.schema.json"),
        "utf8",
      ),
    );
    const validateReview = ajv.compile(reviewSchema);
    const validateResult = ajv.compile(resultSchema);
    assert.equal(validateReview(review), true, JSON.stringify(validateReview.errors));
    assert.equal(validateResult(result), true, JSON.stringify(validateResult.errors));
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("recordProspectReview enforces the strict decision and finding matrix", async () => {
  const cases: Array<{
    name: string;
    patch: Partial<RecordProspectReviewOptions>;
    accepted: boolean;
  }> = [
    {
      name: "consider and needs revision",
      patch: {
        draftLabel: "operator-reviewed-needs-revision",
        reasonCodes: ["draft-needs-revision"],
      },
      accepted: true,
    },
    {
      name: "defer and do not send",
      patch: {
        prospectLabel: "operator-reviewed-defer",
        draftLabel: "operator-reviewed-do-not-send",
        reasonCodes: ["source-review-incomplete"],
        findings: { ...positiveFindings(), citedSource: "incomplete" },
      },
      accepted: true,
    },
    {
      name: "do not contact inappropriate route",
      patch: {
        prospectLabel: "operator-reviewed-do-not-contact",
        draftLabel: "operator-reviewed-do-not-send",
        reasonCodes: ["inappropriate-route"],
        findings: { ...positiveFindings(), contactRoute: "inappropriate" },
      },
      accepted: true,
    },
    {
      name: "defer cannot await authorization",
      patch: {
        prospectLabel: "operator-reviewed-defer",
        reasonCodes: ["timing-deferred"],
      },
      accepted: false,
    },
    {
      name: "positive authorization needs every finding",
      patch: {
        findings: { ...positiveFindings(), financialRisk: "present-or-unresolved" },
      },
      accepted: false,
    },
    {
      name: "incomplete source needs matching reason",
      patch: {
        prospectLabel: "operator-reviewed-defer",
        draftLabel: "operator-reviewed-do-not-send",
        reasonCodes: ["timing-deferred"],
        findings: { ...positiveFindings(), citedSource: "incomplete" },
      },
      accepted: false,
    },
    {
      name: "source reason needs an incomplete source finding",
      patch: {
        prospectLabel: "operator-reviewed-defer",
        draftLabel: "operator-reviewed-do-not-send",
        reasonCodes: ["source-review-incomplete"],
      },
      accepted: false,
    },
    {
      name: "route reason needs an unresolved route",
      patch: {
        prospectLabel: "operator-reviewed-defer",
        draftLabel: "operator-reviewed-do-not-send",
        reasonCodes: ["route-review-incomplete"],
      },
      accepted: false,
    },
    {
      name: "relationship reason needs an incomplete disclosure",
      patch: {
        prospectLabel: "operator-reviewed-defer",
        draftLabel: "operator-reviewed-do-not-send",
        reasonCodes: ["relationship-review-incomplete"],
      },
      accepted: false,
    },
    {
      name: "safety reason needs an unsafe or unresolved finding",
      patch: {
        prospectLabel: "operator-reviewed-defer",
        draftLabel: "operator-reviewed-do-not-send",
        reasonCodes: ["safety-review-incomplete"],
      },
      accepted: false,
    },
    {
      name: "do not contact needs terminal reason",
      patch: {
        prospectLabel: "operator-reviewed-do-not-contact",
        draftLabel: "operator-reviewed-do-not-send",
        reasonCodes: ["route-review-incomplete"],
      },
      accepted: false,
    },
  ];

  for (const entry of cases) {
    const value = await fixture("matrix");
    const request = { ...options(value), ...entry.patch, outputPath: value.outputPath };
    try {
      if (entry.accepted) {
        const result = await recordProspectReview(request, dependencies);
        assert.equal(result.status, "created", entry.name);
      } else {
        await assert.rejects(() => recordProspectReview(request, dependencies), ProspectReviewError, entry.name);
        await assert.rejects(() => lstat(value.outputPath), { code: "ENOENT" });
      }
    } finally {
      await rm(value.directory, { recursive: true, force: true });
    }
  }
});

test("recordProspectReview requires explicit human inputs and exact expected digests", async () => {
  const value = await fixture("inputs");
  try {
    const base = options(value);
    const invalid: Array<Partial<RecordProspectReviewOptions>> = [
      { humanReviewConfirmed: false },
      { reviewerRef: "urn:launchrig:reviewer:not-a-uuid" },
      { reviewedOn: "2026-09-01" },
      { expectedProspectSha256: "a".repeat(64) },
      { expectedDraftSha256: "A".repeat(64) },
      { prospectLabel: "research-prioritized-unreviewed" },
      { draftLabel: "operator-prepared-unreviewed" },
      { reasonCodes: [] },
      { reasonCodes: ["fit-check-boundary-reviewed", "fit-check-boundary-reviewed"] },
      { findings: { ...positiveFindings(), extraFinding: "invalid" } as unknown as ProspectReviewFindings },
    ];
    for (const patch of invalid) {
      await assert.rejects(
        () => recordProspectReview({ ...base, ...patch }, dependencies),
        ProspectReviewError,
      );
      await assert.rejects(() => lstat(value.outputPath), { code: "ENOENT" });
    }
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("record-prospect-review CLI passes explicit human inputs and keeps output path-free", async () => {
  const prospectPath = "/private/prospect-canary.md";
  const draftPath = "/private/draft-canary.md";
  const outputPath = "/private/review-canary.json";
  const out: string[] = [];
  const errors: string[] = [];
  let received: RecordProspectReviewOptions | undefined;
  const result = resultFixture();
  const args = [
    "cohort",
    "record-prospect-review",
    "--prospect",
    prospectPath,
    "--draft",
    draftPath,
    "--expected-prospect-sha256",
    "3".repeat(64),
    "--expected-draft-sha256",
    "4".repeat(64),
    "--reviewer-ref",
    REVIEWER_REF,
    "--reviewed-on",
    "2026-08-31",
    "--prospect-label",
    "operator-reviewed-consider-outreach",
    "--draft-label",
    "operator-reviewed-awaiting-separate-send-authorization",
    "--reason-code",
    "fit-check-boundary-reviewed",
    ...findingArgs(positiveFindings()),
    "--confirm-human-review",
    "--output",
    outputPath,
    "--json",
  ];
  const code = await runCli(
    args,
    { out: (message) => out.push(message), error: (message) => errors.push(message) },
    {
      recordProspectReview: async (value) => {
        received = value;
        return result;
      },
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(JSON.parse(out.join("\n")), result);
  assert.equal(received?.prospectPath, prospectPath);
  assert.equal(received?.draftPath, draftPath);
  assert.equal(received?.outputPath, outputPath);
  assert.equal(received?.humanReviewConfirmed, true);
  assert.deepEqual(received?.reasonCodes, ["fit-check-boundary-reviewed"]);
  assert.deepEqual(received?.findings, positiveFindings());
  assert.doesNotMatch(out.join("\n"), /prospect-canary|draft-canary|review-canary|urn:launchrig:/);

  const unconfirmedOut: string[] = [];
  const unconfirmedErrors: string[] = [];
  const unconfirmedArgs = args.filter((entry) => entry !== "--confirm-human-review");
  const unconfirmedCode = await runCli(unconfirmedArgs, {
    out: (message) => unconfirmedOut.push(message),
    error: (message) => unconfirmedErrors.push(message),
  });
  assert.equal(unconfirmedCode, 2);
  assert.deepEqual(unconfirmedOut, []);
  assert.match(unconfirmedErrors.join("\n"), /Explicit human review confirmation is required/);
  assert.doesNotMatch(unconfirmedErrors.join("\n"), /prospect-canary|draft-canary|review-canary/);

  const rejectedOut: string[] = [];
  const rejectedErrors: string[] = [];
  const rejectedCode = await runCli(
    [...args.slice(0, -1), "--device", "PHONE-SERIAL-CANARY", "--json"],
    { out: (message) => rejectedOut.push(message), error: (message) => rejectedErrors.push(message) },
  );
  assert.equal(rejectedCode, 2);
  assert.deepEqual(rejectedOut, []);
  assert.match(rejectedErrors.join("\n"), /does not accept --device/);
  assert.doesNotMatch(
    rejectedErrors.join("\n"),
    /PHONE-SERIAL-CANARY|prospect-canary|draft-canary|review-canary/,
  );
});

test("record-prospect-review human next step matches the reviewed outcome", async () => {
  const args = [
    "cohort",
    "record-prospect-review",
    "--prospect",
    "/private/prospect.md",
    "--draft",
    "/private/draft.md",
    "--expected-prospect-sha256",
    "3".repeat(64),
    "--expected-draft-sha256",
    "4".repeat(64),
    "--reviewer-ref",
    REVIEWER_REF,
    "--reviewed-on",
    "2026-08-31",
    "--prospect-label",
    "operator-reviewed-consider-outreach",
    "--draft-label",
    "operator-reviewed-awaiting-separate-send-authorization",
    "--reason-code",
    "fit-check-boundary-reviewed",
    ...findingArgs(positiveFindings()),
    "--confirm-human-review",
    "--output",
    "/private/review.json",
  ];
  const cases = [
    {
      prospectLabel: "operator-reviewed-consider-outreach" as const,
      draftLabel: "operator-reviewed-awaiting-separate-send-authorization" as const,
      expected: /only this unchanged reviewed draft/,
    },
    {
      prospectLabel: "operator-reviewed-consider-outreach" as const,
      draftLabel: "operator-reviewed-needs-revision" as const,
      expected: /revise the draft.*new SHA-256.*new human review/i,
    },
    {
      prospectLabel: "operator-reviewed-defer" as const,
      draftLabel: "operator-reviewed-do-not-send" as const,
      expected: /new human review if the deferred conditions change/,
    },
    {
      prospectLabel: "operator-reviewed-do-not-contact" as const,
      draftLabel: "operator-reviewed-do-not-send" as const,
      expected: /do not send this draft/,
    },
  ];
  for (const entry of cases) {
    const out: string[] = [];
    const errors: string[] = [];
    const result = { ...resultFixture(), prospectLabel: entry.prospectLabel, draftLabel: entry.draftLabel };
    const code = await runCli(
      args,
      { out: (message) => out.push(message), error: (message) => errors.push(message) },
      { recordProspectReview: async () => result },
    );
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    assert.match(out.join("\n"), entry.expected);
  }
});

test("recordProspectReview rejects unsafe or ambiguous private files and output locations", async () => {
  const value = await fixture("files");
  try {
    await chmod(value.prospectPath, 0o644);
    await assert.rejects(() => recordProspectReview(options(value), dependencies), /cannot be read safely/);
    await chmod(value.prospectPath, 0o600);

    await assert.rejects(
      () => recordProspectReview({ ...options(value), prospectPath: "relative-prospect.md" }, dependencies),
      /valid absolute path/,
    );

    const linkedProspect = path.join(value.directory, "linked-prospect.md");
    await symlink(value.prospectPath, linkedProspect);
    await assert.rejects(
      () => recordProspectReview({ ...options(value), prospectPath: linkedProspect }, dependencies),
      /symbolic-link component/,
    );

    const hardLinkedProspect = path.join(value.directory, "hard-linked-prospect.md");
    await link(value.prospectPath, hardLinkedProspect);
    await assert.rejects(() => recordProspectReview(options(value), dependencies), /cannot be read safely/);
    await rm(hardLinkedProspect);

    await writeFile(value.draftPath, value.prospectBytes, { mode: 0o600 });
    await chmod(value.draftPath, 0o600);
    await assert.rejects(
      () =>
        recordProspectReview(
          { ...options(value), expectedDraftSha256: digest(value.prospectBytes) },
          dependencies,
        ),
      /distinct private files with distinct bytes/,
    );

    const privateParentFixture = await fixture("private-parent");
    try {
      await chmod(privateParentFixture.directory, 0o755);
      await assert.rejects(
        () => recordProspectReview(options(privateParentFixture), dependencies),
        /owner-controlled and private/,
      );
      await assert.rejects(() => lstat(privateParentFixture.outputPath), { code: "ENOENT" });
    } finally {
      await chmod(privateParentFixture.directory, 0o700).catch(() => undefined);
      await rm(privateParentFixture.directory, { recursive: true, force: true });
    }

    const foreignWorktreeFixture = await fixture("foreign-worktree-inputs");
    try {
      const foreignWorktree = path.join(value.directory, "foreign-worktree");
      const foreignPrivateParent = path.join(foreignWorktree, "private");
      await mkdir(path.join(foreignWorktree, ".git"), { recursive: true, mode: 0o700 });
      await mkdir(foreignPrivateParent, { mode: 0o700 });
      const foreignOutput = path.join(foreignPrivateParent, "review.json");
      await assert.rejects(
        () =>
          recordProspectReview(
            { ...options(foreignWorktreeFixture), outputPath: foreignOutput },
            dependencies,
          ),
        /outside the active Git worktree/,
      );
      await assert.rejects(() => lstat(foreignOutput), { code: "ENOENT" });
    } finally {
      await rm(foreignWorktreeFixture.directory, { recursive: true, force: true });
    }

    const worktreeOutput = path.join(process.cwd(), ".phase-2l-private-review-test.json");
    const restored = await fixture("worktree");
    try {
      await assert.rejects(
        () => recordProspectReview({ ...options(restored), outputPath: worktreeOutput }, dependencies),
        /outside the active Git worktree/,
      );
      await assert.rejects(() => lstat(worktreeOutput), { code: "ENOENT" });
    } finally {
      await rm(restored.directory, { recursive: true, force: true });
    }
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("private prospect review schema rejects runtime-inconsistent decision matrices", async () => {
  const value = await fixture("schema-matrix");
  try {
    await recordProspectReview(options(value), dependencies);
    const review = JSON.parse(await readFile(value.outputPath, "utf8")) as Record<string, any>;
    const schema = JSON.parse(
      await readFile(path.join(process.cwd(), "schemas", "launchrig-private-prospect-review.schema.json"), "utf8"),
    );
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
    ajv.addFormat("date", /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    const validate = ajv.compile(schema);
    assert.equal(validate(review), true, JSON.stringify(validate.errors));

    const mutations = [
      (candidate: Record<string, any>) => {
        candidate.draft.label = "operator-reviewed-do-not-send";
      },
      (candidate: Record<string, any>) => {
        candidate.findings.financialRisk = "present-or-unresolved";
      },
      (candidate: Record<string, any>) => {
        candidate.prospect.label = "operator-reviewed-defer";
        candidate.draft.label = "operator-reviewed-do-not-send";
        candidate.reasonCodes = ["source-review-incomplete"];
      },
      (candidate: Record<string, any>) => {
        candidate.prospect.label = "operator-reviewed-do-not-contact";
        candidate.draft.label = "operator-reviewed-do-not-send";
        candidate.reasonCodes = ["inappropriate-route"];
      },
      (candidate: Record<string, any>) => {
        delete candidate.humanReviewConfirmed;
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(review);
      mutate(candidate);
      assert.equal(validate(candidate), false);
    }
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("recordProspectReview rejects empty, oversized, and invalid UTF-8 inputs", async () => {
  const cases = [
    { name: "empty", bytes: Buffer.alloc(0), pattern: /cannot be read safely/ },
    { name: "oversized", bytes: Buffer.alloc(256 * 1024 + 1, 0x61), pattern: /cannot be read safely/ },
    { name: "invalid-utf8", bytes: Buffer.from([0xc3, 0x28]), pattern: /valid UTF-8/ },
  ];
  for (const entry of cases) {
    const value = await fixture(entry.name);
    try {
      await writeFile(value.prospectPath, entry.bytes, { mode: 0o600 });
      await chmod(value.prospectPath, 0o600);
      await assert.rejects(
        () =>
          recordProspectReview(
            { ...options(value), expectedProspectSha256: digest(entry.bytes) },
            dependencies,
          ),
        entry.pattern,
      );
      await assert.rejects(() => lstat(value.outputPath), { code: "ENOENT" });
    } finally {
      await rm(value.directory, { recursive: true, force: true });
    }
  }
});

test("recordProspectReview refuses overwrite and preserves a private output after verification failure", async () => {
  const value = await fixture("verification");
  try {
    await writeFile(value.outputPath, "owner data\n", { mode: 0o600 });
    await assert.rejects(() => recordProspectReview(options(value), dependencies), /already exists/);
    assert.equal(await readFile(value.outputPath, "utf8"), "owner data\n");
    await rm(value.outputPath);

    await assert.rejects(
      () =>
        recordProspectReview(options(value), {
          ...dependencies,
          verifyWrittenReview: async () => {
            throw new Error("injected verification failure");
          },
        }),
      (error: unknown) =>
        error instanceof ProspectReviewError &&
        error.exitCode === 3 &&
        /mode-600 output may remain/.test(error.message) &&
        !error.message.includes(value.outputPath),
    );
    const metadata = await lstat(value.outputPath);
    assert.ok(metadata.isFile());
    if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o600);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("recordProspectReview detects input mutation before output creation", async () => {
  const value = await fixture("mutation");
  let prospectReads = 0;
  try {
    await assert.rejects(
      () =>
        recordProspectReview(options(value), {
          ...dependencies,
          capturePrivateInput: async (inputPath, label) => {
            const snapshot = await capturePrivateReviewInput(inputPath, label);
            if (inputPath === value.prospectPath && ++prospectReads === 1) {
              await writeFile(value.prospectPath, "# Mutated prospect\n", { mode: 0o600 });
              await chmod(value.prospectPath, 0o600);
            }
            return snapshot;
          },
        }),
      (error: unknown) =>
        error instanceof ProspectReviewError &&
        error.exitCode === 3 &&
        /changed while/.test(error.message),
    );
    await assert.rejects(() => lstat(value.outputPath), { code: "ENOENT" });
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("recordProspectReview detects input mutation after output creation and leaves it private", async () => {
  const value = await fixture("post-write-mutation");
  let prospectReads = 0;
  try {
    await assert.rejects(
      () =>
        recordProspectReview(options(value), {
          ...dependencies,
          capturePrivateInput: async (inputPath, label) => {
            const snapshot = await capturePrivateReviewInput(inputPath, label);
            if (inputPath === value.prospectPath && ++prospectReads === 2) {
              await writeFile(value.prospectPath, "# Mutated after pre-write check\n", { mode: 0o600 });
              await chmod(value.prospectPath, 0o600);
            }
            return snapshot;
          },
        }),
      (error: unknown) =>
        error instanceof ProspectReviewError &&
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

test("prospect review core has no device, runner, pilot-state, contact, or network dependency", async () => {
  const source = await readFile(path.join(process.cwd(), "src", "pilot", "prospect-review.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /device\/adb|runner\/maestro|commands\/run|\.launchrig\/pilots|fetch\(|https?:\/\/|child_process|sendMessage|sendEmail/,
  );
  assert.doesNotMatch(source, /\u2014/);
});
