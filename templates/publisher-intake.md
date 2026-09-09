# LaunchRig publisher intake and go or no-go review

Complete the delivery and initial-permission fields before installing LaunchRig or changing the publisher project. Finalize the exact session-scope approval after configuration and flow promotion, but before any attended device action. Keep the completed copy private.

## Project and people

- Publisher organization:
- Publisher contact:
- LaunchRig operator:
- Authority basis for the organization, project, test build, and evidence decision:
- Device owner or authorized device representative:
- Project or repository in scope:
- Test build identifier:
- Android application ID:
- Planned pilot date:
- Planned LaunchRig bundle ID:
- Planned LaunchRig manifest SHA-256:
- Planned LaunchRig `SHA256SUMS` SHA-256:
- Planned LaunchRig package SHA-256:
- Separate trusted channel used for the four expected values:
- All four values verified before installation, with reviewer and date:
- Related organizations, agencies, clients, forks, white-label apps, shared maintainers, or prior LaunchRig pilots:
- Compensation, conflicts, and prior relationship disclosure:

## Environment readiness

- [ ] Node.js 20.11 or newer is installed.
- [ ] pnpm 10.34.0 is available.
- [ ] Android Platform Tools and ADB are available.
- [ ] Stable Maestro 2.8.0 or newer is the selected UI-runner baseline.
- [ ] One physical Android phone on API 26 or newer is available over USB debugging.
- [ ] The approved test app or its approved APK provenance is known.
- [ ] The network is devnet or testnet, never mainnet.
- [ ] The selected wallet is Mock MWA or the official MWA v2.2.0 reference fake wallet.
- [ ] The test account contains no valuable assets, production keys, or seed phrase used for valuable accounts.

## Product capability readiness

- [ ] The app has a real MWA authorize path.
- [ ] The app has a real SIWS path.
- [ ] The app has a harmless fixed-message signing path.
- [ ] The app has a real wallet-rejection and recovery path.
- [ ] Stable publisher-owned resource IDs or accessibility labels exist for all required actions and outcomes.
- [ ] Four distinct flow definitions can be reviewed and promoted.
- [ ] The publisher understands that wallet approval, rejection, PIN, fingerprint, and face prompts remain manual.
- [ ] Every promoted flow contains no wallet-screen selector or credential input, and the three-repeat run will be attended.

## Permission and privacy readiness

- [ ] Stage A of the pilot consent is complete before installation or project changes.
- [ ] Stage B will approve the exact private session scope and receipt before any attended device action.
- [ ] The attended `launchrig pilot check` and `launchrig pilot run` commands will both receive the same exact approved private scope through mandatory `--scope FILE` options.
- [ ] The publisher representative's authority to approve project changes, testing, and evidence use is confirmed.
- [ ] Device-owner authorization for USB debugging and the reviewed session is confirmed.
- [ ] The named operator has permission to install approved test artifacts and run the reviewed flows.
- [ ] Private configs, proprietary flows, APKs, raw logs, phone serials, credentials, intake, and consent will stay private.
- [ ] Any public evidence or report excerpt will receive a separate sharing review.
- [ ] The publisher understands that an ordinary Android result is not Seeker or Seed Vault evidence.
- [ ] Storage, access, retention, deletion, withdrawal, and material-scope-change rules are recorded.
- [ ] Organization control and project lineage were reviewed under the pilot independence policy.
- [ ] The publisher understands that session-scope equality is self-recorded and does not authenticate consent, publisher identity or authority, bundle authenticity, the operator, device identity, or artifact provenance.
- [ ] The publisher understands that scope-linked evidence v3 discloses a stable approved-scope digest that can link reexports and private records if it is disclosed.
- [ ] The publisher understands that evidence v1 and v2 remain historical verification formats but cannot satisfy private scope-linked governance.

## Decision

Stage A consent, confirmed authority, device-owner authorization, verified delivery values, and explicit permission to install approved artifacts are mandatory before project changes. Stage B consent for the exact scope and flows is mandatory before attended execution. If any required authorization is missing at its gate, select NO-GO. Missing scenario coverage or public-sharing approval may reduce a safe session to a private rehearsal, but missing execution permission may not.

Select exactly one:

- [ ] **PROCEED: Stage A complete; integration preparation authorized.** All required capabilities, safety checks, Stage A permissions, and the plan to complete Stage B before device access are ready. This is not a completed or countable pilot.
- [ ] **PROCEED: private integration rehearsal preparation only.** Stage A permission is complete and the environment is safe, but at least one scenario-coverage or public-sharing requirement is missing. This authorization is not a completed session and cannot count toward the external grant gate.
- [ ] **NO-GO: unsafe, unsupported, or unpermissioned.** Stop if consent or execution permission is missing, or if mainnet, valuable funds, production-wallet automation, emulator-only evidence, unreviewed flows, unknown APK provenance, automated biometrics, or uncontrolled private material is involved.

Decision reason:

- Missing items:
- Approved next action:
- Publisher acknowledgement and date:
- LaunchRig operator acknowledgement and date:
