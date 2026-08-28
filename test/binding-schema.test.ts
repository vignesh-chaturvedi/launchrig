import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

const LIMITATIONS = [
  "The receipt binds exact local file bytes to an internally consistent evidence document, but it is not a signature or publisher attestation.",
  "Any qualified technical status is recomputed from self-recorded evidence fields and does not establish an external publisher, consent, independence, a confirmed defect, Seeker hardware, production-wallet behavior, Seed Vault behavior, or grant readiness.",
];

function receipt(schemaVersion: 1 | 2, technicalStatus: string): Record<string, unknown> {
  return {
    receiptSchemaVersion: 1,
    kind: "launchrig-pilot-evidence-binding-receipt",
    binding: {
      evidenceId: "123e4567-e89b-42d3-a456-426614174000",
      fileSha256: "a".repeat(64),
      evidenceSha256: "b".repeat(64),
      schemaVersion,
    },
    integrityValid: true,
    internalConsistencyValid: true,
    claimStatus: "self-recorded-unattested",
    technicalStatus,
    externalGrantGate: "not-established",
    grantReady: false,
    limitations: LIMITATIONS,
  };
}

test("binding receipt schema ties technical status to the evidence schema version", async () => {
  const source = await readFile(
    path.join(process.cwd(), "schemas", "launchrig-pilot-evidence-binding-receipt.schema.json"),
    "utf8",
  );
  const validate = new Ajv2020({ strict: true }).compile(JSON.parse(source));

  assert.equal(validate(receipt(1, "not-recomputable")), true, JSON.stringify(validate.errors));
  assert.equal(validate(receipt(1, "qualified-self-recorded")), false);
  assert.equal(validate(receipt(1, "not-qualified-self-recorded")), false);
  assert.equal(validate(receipt(2, "qualified-self-recorded")), true, JSON.stringify(validate.errors));
  assert.equal(validate(receipt(2, "not-qualified-self-recorded")), true, JSON.stringify(validate.errors));
  assert.equal(validate(receipt(2, "not-recomputable")), false);
});
