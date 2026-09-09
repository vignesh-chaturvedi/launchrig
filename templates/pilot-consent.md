# LaunchRig pilot consent

Complete this record in two stages. Complete Stage A before installing LaunchRig or changing the publisher project. Complete Stage B after the final configuration and four flows pass `pilot lint`, but before any attended device action. Keep the signed or acknowledged copy private unless every named party approves publication.

## Parties and scope

- Publisher organization:
- Publisher contact:
- LaunchRig operator:
- Consent record version:
- Consent effective date and expiry:
- Publisher representative's authority for the organization, project, test build, and evidence decision:
- Device owner or authorized device representative:
- Project or repository in scope:
- Android application ID:
- Test build version:
- Pilot date:
- Approved device type:
- Approved development wallet:

## Stage A: delivery and initial execution authorization

- LaunchRig bundle ID:
- LaunchRig manifest SHA-256:
- LaunchRig `SHA256SUMS` SHA-256:
- LaunchRig package SHA-256:
- Separate trusted channel used to receive all four values:
- Publisher verified all four values before installation, with acknowledgement and date:
- Approved test-build and wallet-artifact digests:
- Opaque private-register candidate, publisher, project, lineage, and pilot references:

### Stage A permission checklist

- [ ] The publisher representative confirms authority to approve changes and testing for the stated organization, project, and test build.
- [ ] The device owner or authorized representative permits USB debugging and the reviewed actions on the stated device.
- [ ] The publisher permits installation or replacement of the stated publisher test APK when configured.
- [ ] The publisher permits installation or replacement of the exact allowlisted development-wallet APK when configured.
- [ ] The publisher confirms that the device and test accounts contain no valuable funds, production keys, or seed phrases used for valuable accounts.
- [ ] The publisher understands that wallet credentials, PINs, fingerprints, face prompts, approvals, and rejections remain manual.
- [ ] The publisher understands that LaunchRig is not a security audit or transaction certification tool.
- [ ] The publisher understands that an ordinary Android run is not Seeker or Seed Vault evidence.
- [ ] The publisher understands that scope-linked public evidence v3 includes relative run timing, per-export keyed fingerprint groups, and one stable approved-scope digest. The stable scope digest can link reexports and private records if it is disclosed, while evidence IDs, timing, durations, and group patterns may provide additional correlation.
- [ ] The publisher understands that evidence v1 and v2 remain historical verification formats but cannot satisfy the private scope-linked governance threshold.
- [ ] The publisher understands that the default public export does not establish publisher identity, production-wallet behavior, a confirmed defect, Seeker hardware, or Seed Vault behavior.
- [ ] Compensation, conflicts, and prior relationships relevant to this pilot were disclosed.
- [ ] The storage location, approved access list, retention deadline, deletion method, and withdrawal route were reviewed.
- [ ] A material change to the bundle, app build, wallet artifact, device, operator, flow bytes, capture settings, or sharing scope requires renewed review and, when appropriate, renewed consent.
- [ ] The publisher understands that the maintainer may record only opaque references, lifecycle decisions, dates, and record or artifact digests in a restricted private cohort register.
- [ ] The publisher understands that a successful private register audit checks recorded structure and bindings but does not authenticate identity, authority, consent, independence, or grant eligibility.

## Stage B: exact session-scope approval

Complete this stage only after the exact config and four promoted flows pass `pilot lint`. Prepare the private JSON scope outside Git, set its Unix mode to `600`, independently verify every declared artifact digest, and run `launchrig pilot scope FILE --json`.

- Scope record version:
- Approved capture and log policy:
- Exact private scope-file SHA-256 from `scopeFileSha256`:
- Manifest SHA-256 from `bundleVerification.manifestSha256`:
- `SHA256SUMS` SHA-256 from `bundleVerification.sha256SumsSha256`:
- Session `.binding.bundleId`:
- Session `.binding.packageSha256`:
- Session `.binding.appBuildSha256`:
- Session `.binding.walletArtifactSha256`:
- Session `.binding.flowReviewSha256`:
- Canonical pilot-scope SHA-256 from `.binding.scopeSha256`:
- Receipt `policyValid` was exactly `true`: yes / no
- Receipt `claimStatus` was exactly `operator-prepared-unattested`: yes / no
- Receipt external grant gate was `not-established` and `grantReady` was exactly `false`: yes / no

### Stage B approval checklist

- [ ] The publisher reviewed the exact private scope file and every receipt value listed above.
- [ ] The publisher permits LaunchRig to run the four listed reviewed UI flows on the approved test device.
- [ ] The publisher reviewed every promoted flow and confirms it contains no wallet-screen selector or credential input.
- [ ] The publisher approves local creation of sanitized HTML, JSON, JUnit, and private pilot state under the exact retention policy.
- [ ] The publisher reviewed the screenshot and log settings in `launchrig.yml`, and they match the scope policy.
- [ ] The publisher understands that `flowReviewSha256` is a deterministic digest of the declared kind-bound flow inventory, not proof that a human performed the review.
- [ ] The publisher understands that the helper validates declarations and policy but does not open or independently verify the declared bundle, config, app, wallet, or flow artifacts.
- [ ] The publisher understands that exact equality with the operator-prepared scope is self-recorded. It does not authenticate consent, publisher identity or authority, bundle authenticity, the operator, device identity, or artifact provenance.
- [ ] The publisher understands that the receipt is not a signature, consent proof, publisher attestation, device attestation, or grant claim.
- [ ] Immediately before the attended device session, the operator reran `launchrig pilot scope FILE --json` and every approved receipt value matched exactly.
- [ ] The operator will pass the same exact approved private scope through mandatory `--scope FILE` options to both `launchrig pilot check` and `launchrig pilot run`.
- [ ] Only the six-field `.binding` object will be copied into `candidate.session.binding`, and the same `scopeSha256` will be copied into `candidate.consent.scopeSha256`.
- [ ] The full scope receipt, private path, and opaque references will remain outside the public evidence and private register.
- [ ] The publisher understands that the scope path may remain in local shell history.
- [ ] Any mismatch or material scope change stops the session until the exact scope is reviewed and approved again.

## Approved flows

List each scenario ID, purpose, reviewed flow filename, and exact SHA-256:

1.
2.
3.
4.

## Sharing choices

- [ ] Scope-linked public evidence v3 JSON may be shared after exact file review.
- [ ] Sanitized report artifacts may be shared after publisher review.
- [ ] Publisher name may be disclosed.
- [ ] Publisher logo may be used.
- [ ] An approved quote may be used.
- [ ] A confirmed defect may be documented after separate review.

Anything not selected remains private. Public pilot evidence does not establish publisher identity on its own. Its stable scope digest can link approved exports and private records if disclosed.

## Retention and withdrawal

- Private storage location:
- Approved access list:
- Retention deadline:
- Deletion method and responsible operator:
- Withdrawal contact and procedure:
- Treatment of already published material after withdrawal:
- Compensation, conflicts, and prior relationship disclosure:

## Acknowledgement

- Publisher Stage A acknowledgement and date:
- Publisher Stage B acknowledgement and date:
- Device owner acknowledgement and date, when different:
- LaunchRig operator Stage A acknowledgement and date:
- LaunchRig operator Stage B acknowledgement and date:
- Additional restrictions:
