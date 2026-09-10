# Controlled Android wallet recovery

LaunchRig's published snapshot records **3 controlled broken failures and 3 fixed passes**, alongside **3 reference Mobile Wallet Adapter (MWA) suite passes**. It contains **9 normalized reports and 18 scenario checks on 1 physical Android 12 / API 31 device profile**: a Motorola moto g(40) fusion. The evidence is **self-recorded-unattested**. Review the [pinned evidence guide and bundle](https://github.com/vignesh-chaturvedi/launchrig/tree/07160c9e71fa90a5723dbc3da5e42a2cd439996c/evidence/local-android-mwa-v2).

The reference reports cover authorization, Sign In With Solana, harmless message signing, and rejection recovery on testnet with a reference test wallet. Those three reports contribute 12 checks. The six controlled reports use LaunchRig's fixture dApp and Mock MWA Wallet on devnet, contributing one scenario check each. These are deliberately introduced fixture failures, not reported bugs in external applications.

## What the recovery cases exercise

The published fixture source and tests define the behaviors below. Tests use wallet and storage doubles. The normalized evidence records each scenario's pass or fail status; it does not expose individual UI assertions or internal state transitions. Read the behavior descriptions as source contracts, not as a reconstruction of the private recordings.

| Controlled case | Broken behavior defined in source | Fixed behavior defined in source | Published outcomes |
| --- | --- | --- | --- |
| [Wallet rejection](https://github.com/vignesh-chaturvedi/launchrig/blob/07160c9e71fa90a5723dbc3da5e42a2cd439996c/apps/fixture-dapp/features/rejection/rejection-fixture.test.tsx) | A rejected request remains pending and retry stays disabled. | Records `USER_REJECTED`, clears pending state, and enables retry. | Broken: fail. Fixed: pass. |
| [Stale authorization](https://github.com/vignesh-chaturvedi/launchrig/blob/07160c9e71fa90a5723dbc3da5e42a2cd439996c/apps/fixture-dapp/features/stale-authorization/stale-authorization-fixture.test.tsx) | Reusing revoked authorization leaves the request pending and the cached session retained. | Clears cached authorization after the recognized authorization error and supports a new connection. | Broken: fail. Fixed: pass. |
| [dApp process death](https://github.com/vignesh-chaturvedi/launchrig/blob/07160c9e71fa90a5723dbc3da5e42a2cd439996c/apps/fixture-dapp/features/process-death/process-death-fixture.test.tsx) | Restoring an interrupted request leaves it pending. | Records `RECOVERED_UNKNOWN`, preserves the outcome as `UNKNOWN`, and enables retry. | Broken: fail. Fixed: pass. |

The [published automation flows](https://github.com/vignesh-chaturvedi/launchrig/tree/07160c9e71fa90a5723dbc3da5e42a2cd439996c/launchrig-flows) specify the wallet interactions and recovery assertions. The process-death flow stops the dApp while a message request is open, then reopens it. `UNKNOWN` deliberately leaves the interrupted request's signing outcome unresolved.

The [matrix contract](https://github.com/vignesh-chaturvedi/launchrig/blob/07160c9e71fa90a5723dbc3da5e42a2cd439996c/docs/phase-1.md) requires each broken variant to fail at its designated state and each fixed variant to pass. Missing artifacts, unrelated required failures, or changed paired flows invalidate acceptance. Successful matrix acceptance preserves the broken reports as failures.

## Review and reproduction limits

The evidence guide explains how to open the report locally and check its checksum inventory against the pinned snapshot. This verifies published file integrity; it does not authenticate the phone session or independently validate the reports' meaning. Raw input reports remain private, and the exact binary artifacts are not publicly hosted. Checksums therefore do not provide full recreation or independent authenticity.

[Source setup, tests, and Android build instructions](https://github.com/vignesh-chaturvedi/launchrig/blob/07160c9e71fa90a5723dbc3da5e42a2cd439996c/apps/fixture-dapp/README.md) are a separate workflow. A successful source test or newly built candidate does not reproduce the recorded physical results or qualify an exact binary.

This snapshot does not establish production-wallet compatibility, Seeker hardware or Seed Vault testing, on-chain transactions, user adoption, external publisher participation, external application defects, or any grant award. It supplies a bounded, inspectable example of controlled recovery checks on one ordinary Android device profile.
