import { verifyPublicPilotEvidenceWithBinding } from "./public-evidence.js";

const BINDING_LIMITATIONS = [
  "The receipt binds exact local file bytes to an internally consistent evidence document, but it is not a signature or publisher attestation.",
  "Any qualified technical status is recomputed from self-recorded evidence fields and does not establish an external publisher, consent, independence, a confirmed defect, Seeker hardware, production-wallet behavior, Seed Vault behavior, or grant readiness.",
] as const;

export interface PublicPilotEvidenceBindingReceipt {
  receiptSchemaVersion: 1;
  kind: "launchrig-pilot-evidence-binding-receipt";
  binding: {
    evidenceId: string;
    fileSha256: string;
    evidenceSha256: string;
    schemaVersion: 1 | 2 | 3;
  };
  integrityValid: true;
  internalConsistencyValid: true;
  claimStatus: "self-recorded-unattested";
  technicalStatus: "not-recomputable" | "not-qualified-self-recorded" | "qualified-self-recorded";
  externalGrantGate: "not-established";
  grantReady: false;
  limitations: string[];
}

export async function createPublicPilotEvidenceBinding(
  inputPath: string,
): Promise<PublicPilotEvidenceBindingReceipt> {
  const verified = await verifyPublicPilotEvidenceWithBinding(inputPath);
  return {
    receiptSchemaVersion: 1,
    kind: "launchrig-pilot-evidence-binding-receipt",
    binding: {
      evidenceId: verified.evidenceId,
      fileSha256: verified.fileSha256,
      evidenceSha256: verified.evidenceSha256,
      schemaVersion: verified.schemaVersion,
    },
    integrityValid: true,
    internalConsistencyValid: true,
    claimStatus: "self-recorded-unattested",
    technicalStatus:
      verified.schemaVersion === 1
        ? "not-recomputable"
        : verified.reportedTechnicalTargetsMet
          ? "qualified-self-recorded"
          : "not-qualified-self-recorded",
    externalGrantGate: "not-established",
    grantReady: false,
    limitations: [...BINDING_LIMITATIONS],
  };
}
