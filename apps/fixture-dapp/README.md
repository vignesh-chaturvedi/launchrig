# LaunchRig mobile fixture

This Expo Android app is a controlled devnet sample for LaunchRig's three wallet recovery cases. Version 0.2.0 contains all six broken and fixed variants in one arm64 APK and uses `@wallet-ui/react-native-kit` with Mock MWA.

## Recovery cases

| Case                | Broken behavior                                          | Fixed behavior                                                                               |
| ------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Wallet rejection    | Request remains pending and retry is disabled.           | Reports `USER_REJECTED`, clears pending state, and enables retry.                            |
| Stale authorization | Cached authorization leaves the app stuck reconnecting.  | Clears the stale cache, reports `AUTHORIZATION_CLEARED`, and supports a new connection.      |
| dApp process death  | Restored journal leaves the interrupted request pending. | Reports `RECOVERED_UNKNOWN`, preserves the original outcome as `UNKNOWN`, and enables retry. |

Process recovery never guesses whether the interrupted request was signed or rejected. The journal records minimal request state, and the fixture does not display or log authorization tokens or private keys.

Each case has a deep link with an explicit `broken` or `fixed` variant:

```text
launchrig://fixture/rejection?variant=fixed
launchrig://fixture/stale-authorization?variant=fixed
launchrig://fixture/process-death?variant=fixed
```

Replace `fixed` with `broken` to select the deliberate failure. Missing or invalid variants fail closed. Stable automation IDs include `fixture-ready`, `fixture-scenario`, `fixture-variant`, `wallet-state`, and `connect-wallet`, plus the state and retry controls for each case.

## Test the source

Use Node.js 24.3 or later and pnpm 10.34.0. From the repository root:

```bash
pnpm --dir apps/fixture-dapp install --frozen-lockfile
pnpm --dir apps/fixture-dapp test
```

These tests do not need a phone or Android SDK. They test app state and recovery behavior with mocked wallet dependencies; they do not establish physical-wallet behavior or on-chain signing success.

## Build an Android candidate

Build only when an APK is needed. The build requires JDK 17, an Android SDK with the declared SDK platform and build tools, and space for native dependencies. Set `ANDROID_SDK_ROOT` and, if necessary, `LAUNCHRIG_JAVA_HOME` to those installations. From the repository root:

```bash
pnpm fixtures:build-dapp
```

The builder installs the fixture's frozen dependencies, regenerates the ignored Android project, and uses one Gradle worker, a 1536 MB Java heap, and `arm64-v8a` only. The Java heap setting is not a cap on total system memory. APK and provenance files are written beneath `.launchrig/cache/apks/`.

The build contract is in `fixtures/launchrig-dapp-v0.2.0.json`. A binary that differs from its qualified size or SHA-256 is stored as a content-addressed candidate. It cannot replace the stable APK alias merely because compilation succeeded. Qualify that exact candidate through all six physical cases and review the artifact and matrix contracts before promoting it. The tracked matrix expects the declared artifact identities and will reject mismatches.

The local APK uses an Android debug key for USB testing. It is unsuitable for store distribution. No APK or private capture is included or hosted by this source checkout.

## Physical execution

Only device checks and physical runs need the phone. The controlled matrix requires an arm64 Android phone with API 26 or later, authorized USB debugging, the declared Mock MWA artifact, and Maestro at the configured path. The phone owner completes wallet authentication. Mainnet is unsupported.

After the exact artifacts and tooling are ready, run `node dist/src/cli.js matrix` from the repository root. The three broken runs must fail for the declared reasons and the three fixed runs must pass. Do not treat a successful source build or mocked unit test as a substitute for this qualification.

Current scope covers an ordinary Android device with a reference test wallet. Seeker hardware, production wallets, Seed Vault behavior, and successful on-chain transfers have not been validated. See [source setup and scope](../../PUBLIC_SOURCE.md) for the CLI workflow.

## Source and license

The app started from the official `solana-mobile/templates` `mobile/expo-kit-minimal` template pinned at commit `b3352ede8194350bf8fdcfa87fb055f157fea395`. The upstream MIT notice is retained in `LICENSE.template`; fixture-specific changes follow the repository's MIT License.
