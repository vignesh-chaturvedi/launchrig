# Supported environment

The CLI requires Node.js 20.11 or later and pnpm 10.34.0. The Expo fixture requires Node.js 24.3 or later. Type checking, unit tests, package checks, and offline evidence verification do not require a phone.

Physical scenarios use Android Platform Tools and stable Maestro 2.8.0 or later. The supplied profiles require a physical Android phone on API 26 or later. The controlled fixture binary targets arm64. Emulators are not accepted by physical-device profiles.

Networks are devnet or testnet. Mainnet is refused. The upstream MWA reference dApp is fixed to testnet; the LaunchRig controlled lifecycle fixture uses devnet. Managed wallet installation accepts only exact allowlisted test-wallet identities and artifacts. Production wallet installation and automated interaction are disabled.

The source builders use one Gradle worker with bounded Java heaps. Building APKs requires a JDK and the SDK versions declared in fixture metadata. Build dependencies can consume significant disk space and are optional for CLI-only development.

The committed APK digests describe specific previously qualified test artifacts. APKs are not distributed in this checkout. A different locally built APK is a candidate requiring physical qualification and a deliberate contract update. Compiler success does not certify compatibility.

Current evidence concerns ordinary Android and test wallets. Seeker hardware, Seed Vault behavior, production-wallet behavior, and downstream publisher use require separate validation. Schema readiness labels must be interpreted within these limits.
