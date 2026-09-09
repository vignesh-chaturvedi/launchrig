# Private cohort audit

This command checks a restricted operator register against exact public evidence. It checks record structure, state, relationships, consent and sharing declarations, and matching evidence bindings. It cannot authenticate those declarations.

```bash
node dist/src/cli.js cohort audit /private/path/register.json /absolute/path/evidence.json --json
```

Create an empty register using `cohort prepare-register` with a new absolute output path outside Git. The file must retain mode 600. Use only opaque references and supported status values. Store actual contacts, acknowledgements, and permission material separately with appropriate access controls.

Only scope-linked evidence v3 can satisfy the current register's technical binding requirements. Review exact approved scope bytes and all session binding fields. Review exact public evidence and use `pilot binding FILE --json` for its file digest, evidence digest, ID, and schema version.

The audit excludes incomplete, expired, withdrawn, related, duplicate, or mismatched records as specified by its schema. It emits aggregate counts and fixed statuses rather than contacts or project paths. Integrity hashes detect changes; they do not prove the truth of an operator statement.

A generic request to continue does not fill or approve records. Keep completed registers, contact records, scope files, and private receipts out of this source repository. See [scoped publisher validation](phase-2.md).
