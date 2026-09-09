# LaunchRig pilot sharing review

Complete this review after the pilot and before sending any file outside the approved publisher group. Keep this completed checklist private unless the publisher approves publication.

## Bundle material

Blank bundle documents, the exact tarball, `manifest.json`, and `SHA256SUMS` may be delivered only through the publisher-approved channel. The checksums provide transfer integrity, not a maintainer signature.

## Publicly eligible after verification and consent

- [ ] The scope-linked evidence v3 JSON passes `launchrig pilot verify` without edits.
- [ ] `launchrig pilot binding EVIDENCE --json` produced a receipt for the exact candidate file.
- [ ] The exact four values from `.binding` are recorded below. The full receipt will not be copied into the register.
- [ ] The publisher approves sharing the exact evidence file and approves these exact four binding values.
- [ ] Immediately before private-register insertion, the operator reran the binding command and all four `.binding` values remained equal.
- [ ] The file remains labeled `self-recorded-unattested`.
- [ ] All external claims remain `not-established`.
- [ ] The evidence v3 stable scope digest equals the approved session and consent scope digest.
- [ ] The publisher reviewed relative timing, stable evidence-ID linkability, per-export fingerprint grouping, and stable scope-digest linkability across reexports and private records.
- [ ] The publisher understands that technical and scope equality is self-recorded and does not authenticate consent, publisher identity or authority, bundle authenticity, the operator, device identity, or artifact provenance.
- [ ] Evidence v1 and v2 are retained only as historical verification formats and cannot satisfy private scope-linked governance.

Only an approved, verified, scope-linked evidence v3 JSON is eligible by default. Eligibility is not automatic publication permission.

- `.binding.evidenceId`:
- `.binding.fileSha256`:
- `.binding.evidenceSha256`:
- `.binding.schemaVersion`:
- Evidence v3 stable scope SHA-256:
- Consent record version and SHA-256:

The top-level `receiptSchemaVersion` describes the receipt format and is not part of the private-register binding. The `schemaVersion` recorded above comes from `.binding.schemaVersion` and describes the public evidence format.

## File-by-file publisher review required

Mark each approved item and identify the exact file or wording:

- [ ] Sanitized HTML report:
- [ ] Sanitized JSON report:
- [ ] Sanitized JUnit report:
- [ ] Screenshot:
- [ ] Log excerpt:
- [ ] Pilot-notes excerpt:
- [ ] Publisher quote:
- [ ] Publisher name:
- [ ] Publisher logo:
- [ ] Defect record:
- [ ] Issue, patch, or repository link:

Screenshots and logcat excerpts remain high sensitivity even after automated redaction. Review their visible content manually.

## Never public from this workflow

- [ ] Confirmed: `.launchrig/pilots` and private `evidence.json` are not selected.
- [ ] Confirmed: completed intake and consent records are not selected.
- [ ] Confirmed: app APKs and wallet APKs are not selected.
- [ ] Confirmed: credentials, PINs, seed phrases, keys, tokens, and test-account details are not selected.
- [ ] Confirmed: device serials and raw whole-device logs are not selected.
- [ ] Confirmed: private configuration, proprietary flows, and the complete `.launchrig/results` directory are not selected.
- [ ] Confirmed: no Seeker, Seed Vault, production-wallet, or confirmed-defect claim is inferred without its separate evidence process.
- [ ] Confirmed: the publisher's withdrawal status was checked immediately before delivery or publication.
- [ ] Confirmed: any withdrawal will be recorded in the restricted private register before the next cohort audit.

## Approval

- Exact approved files and wording:
- Required redactions:
- Approved delivery or publication channel:
- Retention or removal deadline for the approved copy:
- Withdrawal contact and treatment of already published material:
- Publisher acknowledgement and date:
- LaunchRig operator acknowledgement and date:
