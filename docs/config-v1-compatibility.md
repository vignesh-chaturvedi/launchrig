# Configuration v1

`schemas/launchrig.schema.json` describes raw configuration. The runtime applies defaults after validation. Unknown keys, mainnet, unsupported wallet identities, unsafe flows, and ambiguous scalar values are rejected.

```bash
node dist/src/cli.js validate --config launchrig.yml --json
```

The result contains five ordered rules: LR001 schema, LR002 network, LR003 wallet, LR004 privacy, and LR005 input files. Each uses `passed`, `failed`, or `not-evaluated` with diagnostics and stable machine codes. Input-file checks require the actual declared artifacts and flows. Validation itself does not invoke a device.

The parity corpus contains 26 portable cases and two runtime extensions. Duplicate scenario IDs and invalid JavaScript redaction expressions are rejected by the runtime even where portable JSON Schema cannot enforce the same constraint. The tests reject undeclared differences between the two validators.

Scenario IDs are at most 64 characters. `none` and `selection` are reserved to avoid runtime check-ID collisions. Values are not silently trimmed. Numeric bounds, supported network labels, wallet identities, and defaults are shared with the runtime contract.

Installation is disabled by default and requires an APK path when enabled. Managed wallets are limited to the reference fake wallet and Mock MWA artifacts. Real-wallet mode disables installation and automated scenarios, requires screenshots to be `never`, and forbids logcat capture.

Changes to defaults, accepted input, wallet identity, or normalized output require compatibility review. The JSON schema version must not be treated as a guarantee that arbitrary flow commands or wallet operations are safe.
