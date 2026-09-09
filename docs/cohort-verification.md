# Evidence-set verification

```bash
node dist/src/cli.js cohort verify /absolute/path/evidence-1.json /absolute/path/evidence-2.json --json
```

The verifier accepts a bounded set of public pilot evidence files, validates each format, rejects duplicate evidence IDs or file identities, and recomputes qualifying technical results. It performs no device or network operation.

Evidence v1 and v2 remain historical formats. Evidence v3 additionally binds execution to a scope digest. Aggregate technical counts do not establish how many independent publishers or projects participated. Those identities and permission decisions require separate records.

Inputs must be bounded regular files with supported encoding. Symlinks, unsafe aliases, unexpected fields, contradictory counts, or mutation during reading cause refusal. A checksum is not an attestation.

The result reports verification status and explicit limitations. Keep `grantReady` and external-claim fields at their declared values; do not infer eligibility, adoption, identity, or a hardware result from a technical count. Use [cohort audit](cohort-audit.md) when reviewing private operator records against verified evidence.
