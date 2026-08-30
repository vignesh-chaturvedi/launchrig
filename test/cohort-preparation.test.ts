import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
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
  preparePrivateCohortRegister,
  type PrivateCohortRegisterDraftResultV1,
} from "../src/pilot/cohort-preparation.js";
import { auditPrivateCohortRegister, CohortRegisterError } from "../src/pilot/cohort-register.js";
import { sha256Value } from "../src/pilot/store.js";

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stubResult(): PrivateCohortRegisterDraftResultV1 {
  return {
    schemaVersion: 1,
    kind: "launchrig-private-cohort-register-draft-result",
    profile: "phase-2i-recruitment-register-v1",
    claimStatus: "operator-prepared-unattested",
    status: "created",
    fileSha256: "1".repeat(64),
    contentSha256: "2".repeat(64),
    revision: 1,
    targetPublisherProjects: 3,
    candidateRecords: 0,
    interestRecorded: 0,
    integrityRecorded: false,
    humanRecruitmentRequired: true,
    projectModificationAuthorized: false,
    phoneAccessAuthorized: false,
    pilotStateChecked: false,
    deviceEnvironmentChecked: false,
    candidatePool: "not-established",
    publisherIdentity: "not-established",
    publisherAuthority: "not-established",
    publisherConsent: "not-established",
    publisherIndependence: "not-established",
    externalGrantGate: "not-established",
    grantReady: false,
    limitations: ["Private bookkeeping only."],
  };
}

test("prepare-register creates and reaudits an empty mode-600 private register", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "launchrig-cohort-prepare-")));
  const outputPath = path.join(directory, "private-register.json");
  try {
    const beforeDate = new Date().toISOString().slice(0, 10);
    const result = await preparePrivateCohortRegister({ outputPath });
    const afterDate = new Date().toISOString().slice(0, 10);
    const bytes = await readFile(outputPath);
    const register = JSON.parse(bytes.toString("utf8")) as Record<string, any>;
    const metadata = await lstat(outputPath);

    assert.equal(result.kind, "launchrig-private-cohort-register-draft-result");
    assert.equal(result.claimStatus, "operator-prepared-unattested");
    assert.equal(result.fileSha256, digest(bytes));
    assert.equal(result.candidateRecords, 0);
    assert.equal(result.interestRecorded, 0);
    assert.equal(result.candidatePool, "not-established");
    assert.equal(result.projectModificationAuthorized, false);
    assert.equal(result.phoneAccessAuthorized, false);
    assert.equal(result.pilotStateChecked, false);
    assert.equal(result.deviceEnvironmentChecked, false);
    assert.equal(result.grantReady, false);
    assert.ok(metadata.isFile());
    assert.equal(metadata.nlink, 1);
    if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o600);
    if (typeof process.getuid === "function") assert.equal(metadata.uid, process.getuid());

    assert.equal(register.schemaVersion, 1);
    assert.equal(register.kind, "launchrig-private-cohort-register");
    assert.equal(register.profile, "phase-2c-publisher-governance-v1");
    assert.equal(register.privacyProfile, "opaque-refs-digests-dates-v1");
    assert.ok(register.asOfDate === beforeDate || register.asOfDate === afterDate);
    assert.deepEqual(register.candidates, []);
    assert.deepEqual(register.defects, []);
    assert.equal(register.integritySha256, null);
    assert.match(register.registerRef, /^urn:launchrig:register:[a-f0-9-]{36}$/);
    assert.match(register.operatorRef, /^urn:launchrig:operator:[a-f0-9-]{36}$/);
    assert.notEqual(register.registerRef.slice(-36), register.operatorRef.slice(-36));

    const { integritySha256: _integrity, ...core } = register;
    assert.equal(result.contentSha256, sha256Value(core));
    const audit = await auditPrivateCohortRegister(outputPath);
    assert.equal(audit.register.fileSha256, result.fileSha256);
    assert.equal(audit.register.contentSha256, result.contentSha256);
    assert.equal(audit.summary.candidateRecords, 0);
    assert.equal(audit.summary.interestRecorded, 0);
    assert.equal(audit.summary.recordedGovernanceAndTechnicalThresholdMet, false);
    assert.equal(audit.externalGrantGate.status, "not-established");
    assert.equal(audit.grantReady, false);

    const publicResult = JSON.stringify(result);
    assert.doesNotMatch(publicResult, /urn:launchrig:/);
    assert.doesNotMatch(publicResult, /private-register\.json/);
    assert.doesNotMatch(publicResult, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(publicResult, /Android Device Ready|Android\/MWA Ready/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepare-register result conforms to the strict path-free schema", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "launchrig-cohort-schema-")));
  try {
    const result = await preparePrivateCohortRegister({
      outputPath: path.join(directory, "cohort.json"),
    });
    const schema = JSON.parse(
      await readFile(
        path.join(process.cwd(), "schemas", "launchrig-private-cohort-register-draft-result.schema.json"),
        "utf8",
      ),
    );
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    assert.equal(ajv.validate(schema, result), true, JSON.stringify(ajv.errors));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepare-register refuses overwrite, relative paths, unsafe parents, and Git worktree output", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "launchrig-cohort-refuse-")));
  try {
    const existingPath = path.join(directory, "existing.json");
    await writeFile(existingPath, "owner data\n", { mode: 0o600 });
    await assert.rejects(
      () => preparePrivateCohortRegister({ outputPath: existingPath }),
      (error: unknown) => error instanceof CohortRegisterError && /already exists/.test(error.message),
    );
    assert.equal(await readFile(existingPath, "utf8"), "owner data\n");

    await assert.rejects(
      () => preparePrivateCohortRegister({ outputPath: "relative-register.json" }),
      /must be absolute/,
    );
    const controlPath = path.join(directory, "private\nregister.json");
    await assert.rejects(
      () => preparePrivateCohortRegister({ outputPath: controlPath }),
      (error: unknown) =>
        error instanceof CohortRegisterError &&
        /path is invalid/.test(error.message) &&
        !error.message.includes(controlPath),
    );
    await assert.rejects(() => lstat(controlPath), { code: "ENOENT" });
    await assert.rejects(
      () => preparePrivateCohortRegister({ outputPath: path.join(directory, "missing", "cohort.json") }),
      /cannot be resolved safely/,
    );

    const linkedParent = path.join(directory, "linked-parent");
    await symlink(directory, linkedParent);
    await assert.rejects(
      () => preparePrivateCohortRegister({ outputPath: path.join(linkedParent, "linked.json") }),
      /cannot be created safely/,
    );

    const worktreePath = path.join(process.cwd(), ".cohort-private-" + randomUUID() + ".json");
    await assert.rejects(
      () => preparePrivateCohortRegister({ outputPath: worktreePath }),
      /outside the active Git worktree/,
    );
    await assert.rejects(() => lstat(worktreePath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepare-register reports post-write verification failures without deleting private files", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "launchrig-cohort-mode-")));
  const outputPath = path.join(directory, "cohort.json");
  try {
    await preparePrivateCohortRegister({ outputPath });
    await chmod(outputPath, 0o644);
    await assert.rejects(() => auditPrivateCohortRegister(outputPath), /cannot be read safely/);
    assert.ok((await lstat(outputPath)).isFile());

    const auditFailurePath = path.join(directory, "audit-failure.json");
    await assert.rejects(
      () =>
        preparePrivateCohortRegister(
          { outputPath: auditFailurePath },
          { auditPrivateCohortRegister: async () => { throw new Error("injected audit failure"); } },
        ),
      (error: unknown) =>
        error instanceof CohortRegisterError &&
        error.exitCode === 3 &&
        /mode-600 file may remain/.test(error.message) &&
        !error.message.includes(auditFailurePath),
    );
    const auditFailureMetadata = await lstat(auditFailurePath);
    assert.ok(auditFailureMetadata.isFile());
    if (process.platform !== "win32") assert.equal(auditFailureMetadata.mode & 0o777, 0o600);

    const identityFailurePath = path.join(directory, "identity-failure.json");
    await assert.rejects(
      () =>
        preparePrivateCohortRegister(
          { outputPath: identityFailurePath },
          { privateFileIdentityMatches: async () => false },
        ),
      (error: unknown) =>
        error instanceof CohortRegisterError &&
        error.exitCode === 3 &&
        /mode-600 file may remain/.test(error.message) &&
        !error.message.includes(identityFailurePath),
    );
    const identityFailureMetadata = await lstat(identityFailurePath);
    assert.ok(identityFailureMetadata.isFile());
    if (process.platform !== "win32") assert.equal(identityFailureMetadata.mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepare-register CLI is path-free and rejects device-facing options without echoing values", async () => {
  const outputPath = path.join(os.tmpdir(), "private-contact-app-phone-canary.json");
  const out: string[] = [];
  const errors: string[] = [];
  let receivedPath = "";
  const result = stubResult();
  const code = await runCli(
    ["cohort", "prepare-register", "--output", outputPath, "--json"],
    { out: (message) => out.push(message), error: (message) => errors.push(message) },
    {
      preparePrivateCohortRegister: async (options) => {
        receivedPath = options.outputPath;
        return result;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(receivedPath, outputPath);
  assert.deepEqual(JSON.parse(out.join("\n")), result);
  assert.deepEqual(errors, []);
  assert.doesNotMatch(out.join("\n"), /private-contact-app-phone-canary/);

  const rejectedOut: string[] = [];
  const rejectedErrors: string[] = [];
  const rejectedCode = await runCli(
    [
      "cohort",
      "prepare-register",
      "--output",
      outputPath,
      "--device",
      "PHONE-SERIAL-CANARY",
    ],
    { out: (message) => rejectedOut.push(message), error: (message) => rejectedErrors.push(message) },
  );
  assert.equal(rejectedCode, 2);
  assert.deepEqual(rejectedOut, []);
  assert.match(rejectedErrors.join("\n"), /does not accept --device/);
  assert.doesNotMatch(rejectedErrors.join("\n"), /PHONE-SERIAL-CANARY|private-contact-app-phone-canary/);
});

test("prepare-register implementation has no device, runner, pilot-state, or network dependency", async () => {
  const source = await readFile(path.join(process.cwd(), "src", "pilot", "cohort-preparation.ts"), "utf8");
  assert.doesNotMatch(source, /device\/adb|runner\/maestro|\.launchrig\/pilots|fetch\(|https?:\/\//);
});
