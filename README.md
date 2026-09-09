# LaunchRig

The release test rig for Solana Mobile apps.

LaunchRig is a TypeScript CLI prototype for checking an Android app on a physical phone over USB. It validates configuration, checks device and package readiness, runs Maestro scenarios sequentially, and writes HTML, JSON, and JUnit reports.

The current validation scope is ordinary Android with reference MWA and Mock MWA test wallets. The controlled app exercises wallet rejection, stale authorization, and recovery after the dApp process dies. Mainnet is unsupported. Seeker hardware, production wallets, and Seed Vault behavior have not been validated.

## Start with the CLI

Use Node.js 20.11 or later and pnpm 10.34.0. From this source checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/src/cli.js --help
node dist/src/cli.js rules --json
```

These commands need no Android SDK, phone, or emulator. The CLI package has `private: true` to prevent accidental npm publication. This checkout does not imply an npm release or a hosted APK download.

Development checks also run without a phone:

```bash
pnpm check
pnpm test
pnpm package:smoke
```

`pnpm test` builds the CLI before running its tests. The fixture app has its own dependencies and tests; install them only when working on that app.

## Run on a phone

Physical execution needs Android Platform Tools (`adb`), Maestro, the configured app and test-wallet APKs, and an unlocked Android phone with USB debugging authorized. The supplied profiles require API 26 or later. Their Maestro path is `.launchrig/tools/maestro-2.8.0/maestro/bin/maestro`; provide Maestro 2.8.0 there before using the unchanged controlled profiles.

The reference suite downloads pinned upstream test artifacts with size and SHA-256 checks:

```bash
pnpm fixtures:fetch
node dist/src/cli.js validate --config launchrig.yml
```

Connect the phone and accept its USB debugging prompt before running:

```bash
node dist/src/cli.js doctor --config launchrig.yml
node dist/src/cli.js run --config launchrig.yml
```

With multiple devices connected, add `--device SERIAL` to both commands, using the selected phone's serial from `adb devices`. Keep device serials out of committed configuration.

The default `launchrig.yml` uses the upstream reference dApp's fixed testnet configuration. Its authorization, SIWS, message-signing, and rejection scenarios do not require an on-chain transfer. The separate controlled lifecycle app uses devnet with Mock MWA. Mock MWA authentication must be completed by the phone's owner when required.

`doctor` checks readiness. `run` can install the configured app and allowlisted test-wallet artifacts, operate their UI, and write local reports. Review the selected config and flow before executing them on your device.

## Controlled recovery matrix

The source checkout contains three deliberately broken cases and three corresponding fixed cases. After preparing the exact fixture and Mock MWA artifacts, run:

```bash
node dist/src/cli.js matrix
```

The matrix accepts only the declared sequence of three expected failures and three fixed passes, with matching configuration, flow, and artifact identities. An expected failure remains a failed scenario in its own report. The matrix is a controlled regression check, not evidence of defects in another app.

Fixture APKs are not included or hosted here. A locally rebuilt APK whose size or SHA-256 differs from the tracked qualified identity is a new candidate. It needs separate physical qualification before its identity can replace the declared contract. A successful source build alone does not reproduce a physical result.

## Reports and limits

Reports are written under `.launchrig/`, which is ignored by Git. LaunchRig redacts known identifiers, disables logcat by default, and captures screenshots only on failure in the supplied profiles. Inspect report text and screenshots before sharing them; arbitrary app UI can contain private information.

`Android/MWA Ready` describes the selected checks for that run. Reports are self-recorded and unattested. They do not certify device identity, production-wallet compatibility, Seed Vault behavior, on-chain transaction success, or Seeker readiness. Real-wallet automation is disabled; mainnet configuration is refused.

The repository includes configuration schemas, a configuration-validation GitHub Action, fixture flows, and additional CLI commands available through `--help`. See [source setup and scope](PUBLIC_SOURCE.md) for the supported source workflow.

## License

LaunchRig is provided under the MIT License in `LICENSE`. The fixture app retains the upstream template notice in `apps/fixture-dapp/LICENSE.template`.
