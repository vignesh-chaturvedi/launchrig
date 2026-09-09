# Rule catalog and executable contracts

The legacy filename identifies rule-catalog documentation in the package inventory.

```bash
node dist/src/cli.js rules
node dist/src/cli.js rules --json
```

The catalog defines 25 rules: five configuration rules, thirteen runtime rules, and seven publisher preflight rules. Each definition identifies its check ID, implementation, and test contract. Catalog content has a deterministic digest.

LR001 through LR005 cover schema, network, wallet, privacy, and input-file checks. LR006 through LR018 cover runtime readiness and scenario execution. LR019 through LR025 cover recorded pilot state, policy, required scenarios, device and wallet boundaries, repeatability inputs, and environment readiness.

Versioned fixture corpora under `schemas/fixtures/` exercise positive and inverse cases using generated test inputs. Configuration parity tests compare runtime validation with Draft 2020-12 JSON Schema. Runtime and pilot corpora run without a phone and check stable, ordered results.

These are source contracts. They do not establish independent review, production-wallet compatibility, device attestation, or a hardware release qualification. The current catalog preserves `pre-award-foundation` and `grantMilestoneComplete: false` for compatibility.

See [configuration compatibility](config-v1-compatibility.md) and [validation Action](github-action.md).
