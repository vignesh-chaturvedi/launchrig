# Publisher quickstart

See [contact records](publisher-recruitment.md) for recording actual interest and [cohort audit](cohort-audit.md) for reviewing private records against verified evidence.

Use a test build on devnet or testnet and a nonvaluable test account. Confirm permission for project changes and package installation first. Record a separate device and scope approval before execution. The blank consent and intake templates describe those decisions.

After verifying the selected delivery artifact, start measurement before integration work:

```bash
pnpm exec launchrig pilot start --pilot publisher-01 --config launchrig.yml
pnpm exec launchrig pilot lint --config launchrig.yml
```

Promote four publisher-owned flows with stable app selectors for authorize, SIWS, harmless message signing, and rejection recovery. Remove template selectors. Wallet prompts and credentials remain manual.

Use `pilot prepare-scope` with the config, exact verified bundle, a retention expiry, deletion policy, and a new private output path. See CLI help for required flags. Review the generated mode-600 file with the publisher, then run:

```bash
pnpm exec launchrig pilot scope /private/path/scope.json --json
```

Approve the exact file digest and all binding values. Immediately before execution, rerun the receipt and compare them. Pass the same file to both attended commands:

```bash
pnpm exec launchrig pilot check --pilot publisher-01 --config launchrig.yml --scope /private/path/scope.json
pnpm exec launchrig pilot run --pilot publisher-01 --config launchrig.yml --scope /private/path/scope.json --repeat 3
```

A changed configuration, artifact, flow, or permission scope stops the session. Keep state and scope files private. Export only after the session and use `pilot verify FILE` plus a separate sharing review for each artifact. A passed run does not authenticate consent or prove production-wallet, Seeker, or Seed Vault behavior.
