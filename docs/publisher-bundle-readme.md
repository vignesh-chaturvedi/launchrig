# Publisher bundle

This format packages the CLI, technical documentation, blank record templates, a manifest, and a checksum inventory. It does not include publisher APKs, wallet APKs, private state, or completed records.

Verify a bundle before installing:

```bash
node scripts/verify-pilot-bundle.mjs /absolute/path/to/bundle
```

Compare its bundle ID, manifest SHA-256, `SHA256SUMS` SHA-256, and package SHA-256 with values received through a trusted channel. Checksums establish byte integrity; they are not signatures or evidence of publisher consent.

The verifier audits the exact outer inventory and tar archive without extraction, including package metadata, runtime dependencies, file kinds, and supported profile. Historical profiles have separate inventories and are not interchangeable.

The source-only `pnpm pilot:bundle -- --output /absolute/path/to/new-bundle` command requires a clean committed checkout, locked dependencies, and successful source and consumer checks. It refuses to overwrite a destination. Building a bundle creates no hosted release and contacts nobody.

Read `docs/publisher-pilot-quickstart.md` from the checkout or bundle root before installation and use the blank templates for actual permission decisions. Source contract fields describing readiness remain limited to their declared technical meaning.
