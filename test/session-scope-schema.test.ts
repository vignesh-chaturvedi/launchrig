import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createPilotSessionScopeReceipt } from "../src/pilot/session-scope.js";

function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function input(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "launchrig-pilot-session-scope",
    profile: "external-mwa-pilot-scope-v1",
    scopeRef: "urn:launchrig:scope:123e4567-e89b-42d3-a456-426614174000",
    operatorRef: "urn:launchrig:operator:223e4567-e89b-42d3-a456-426614174000",
    pilotRef: "urn:launchrig:pilot:323e4567-e89b-42d3-a456-426614174000",
    deviceRef: "urn:launchrig:device:423e4567-e89b-42d3-a456-426614174000",
    bundle: {
      bundleId: "sha256:" + digest("bundle"),
      manifestSha256: digest("manifest"),
      sha256SumsSha256: digest("sums"),
      packageSha256: digest("package"),
    },
    inputs: {
      configSha256: digest("config"),
      appBuildSha256: digest("app"),
      walletArtifactSha256: digest("wallet"),
      flows: [
        { kind: "mwa-authorize", scenarioId: "authorize", fileSha256: digest("authorize") },
        { kind: "mwa-siws", scenarioId: "siws", fileSha256: digest("siws") },
        { kind: "mwa-sign-message", scenarioId: "sign-message", fileSha256: digest("sign-message") },
        { kind: "mwa-reject", scenarioId: "reject", fileSha256: digest("reject") },
      ],
    },
    policy: {
      network: "devnet",
      walletMode: "mock-mwa",
      physicalAndroidRequired: true,
      attendedExecutionRequired: true,
      manualWalletActionsRequired: true,
      valuableAssetsAllowed: false,
      capture: { screenshots: "failure", includeLogcat: false, logcatLines: 200 },
      retention: { maxRuns: 5, expiresOn: "2026-12-31", deletionMethod: "standard-delete" },
      sharing: {
        publicEvidenceJson: true,
        sanitizedReports: false,
        publisherName: false,
        publisherLogo: false,
        approvedQuote: false,
        confirmedDefectRecord: false,
      },
    },
  };
}

test("session scope input and receipt schemas strictly validate runtime output", async () => {
  const [inputSource, receiptSource, registerSource] = await Promise.all([
    readFile(path.join(process.cwd(), "schemas", "launchrig-pilot-session-scope.schema.json"), "utf8"),
    readFile(path.join(process.cwd(), "schemas", "launchrig-pilot-session-scope-receipt.schema.json"), "utf8"),
    readFile(path.join(process.cwd(), "schemas", "launchrig-private-cohort-register.schema.json"), "utf8"),
  ]);
  const ajv = new Ajv2020({ strict: true });
  ajv.addFormat("date", /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  const validateInput = ajv.compile(JSON.parse(inputSource));
  const validateReceipt = ajv.compile(JSON.parse(receiptSource));
  const registerSchema = JSON.parse(registerSource);
  ajv.addSchema(registerSchema);
  const validateSessionBinding = ajv.compile({
    $ref: registerSchema.$id + "#/$defs/sessionBinding",
  });

  const value = input();
  assert.equal(validateInput(value), true, JSON.stringify(validateInput.errors));
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-session-scope-schema-"));
  try {
    const target = path.join(directory, "scope.json");
    await writeFile(target, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await chmod(target, 0o600);
    const receipt = await createPilotSessionScopeReceipt(target);
    assert.equal(validateReceipt(receipt), true, JSON.stringify(validateReceipt.errors));
    assert.equal(validateSessionBinding(receipt.binding), true, JSON.stringify(validateSessionBinding.errors));

    assert.equal(validateReceipt({ ...receipt, grantReady: true }), false);
    assert.equal(validateReceipt({ ...receipt, publisherIdentity: "established" }), false);
    assert.equal(validateReceipt({ ...receipt, consentAuthenticity: "established" }), false);
    assert.equal(validateReceipt({ ...receipt, privatePath: target }), false);

    const unsafe = structuredClone(value) as Record<string, any>;
    unsafe.policy.valuableAssetsAllowed = true;
    assert.equal(validateInput(unsafe), false);
    const duplicateKind = structuredClone(value) as Record<string, any>;
    duplicateKind.inputs.flows[1].kind = "mwa-authorize";
    assert.equal(validateInput(duplicateKind), false);

    const runtimeDistinctness = structuredClone(value) as Record<string, any>;
    runtimeDistinctness.inputs.flows[1].scenarioId = runtimeDistinctness.inputs.flows[0].scenarioId;
    runtimeDistinctness.inputs.flows[1].fileSha256 = runtimeDistinctness.inputs.flows[0].fileSha256;
    assert.equal(validateInput(runtimeDistinctness), true, "standard schema leaves cross-item distinctness to the CLI");
    await writeFile(target, JSON.stringify(runtimeDistinctness, null, 2) + "\n", { mode: 0o600 });
    await assert.rejects(() => createPilotSessionScopeReceipt(target), /distinct kinds, scenario IDs, and digests/);

    const runtimeCalendarDate = structuredClone(value) as Record<string, any>;
    runtimeCalendarDate.policy.retention.expiresOn = "2026-02-30";
    assert.equal(validateInput(runtimeCalendarDate), true, "standard schema leaves calendar validity to the CLI");
    await writeFile(target, JSON.stringify(runtimeCalendarDate, null, 2) + "\n", { mode: 0o600 });
    await assert.rejects(() => createPilotSessionScopeReceipt(target), /retention expiry is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
