# Scoped publisher validation

The legacy filename identifies publisher workflow documentation in the package inventory.

The `pilot` commands support configuration policy checks, setup timing, repeatability, scope binding, and privacy-limited evidence export. The `cohort` commands verify evidence sets and audit operator-recorded private register entries.

Use `pilot lint` before execution. It requires four distinct publisher flows for MWA authorization, SIWS, harmless message signing, and rejection recovery. Controlled LaunchRig fixtures do not count as publisher validation. Start the setup timer before integration work when measuring setup time.

Record permission before project changes, then approve the exact configuration, artifacts, four flows, retention, and sharing policy before device execution. `pilot prepare-scope` prepares a private draft from exact inputs. `pilot scope FILE --json` reports the digest and binding fields for review.

Both `pilot check` and `pilot run` require the approved `--scope FILE`. Changed scope or artifacts require renewed review. Repeated runs must be attended when manual wallet interaction is required.

Exported evidence v3 links to the approved scope digest. `pilot verify FILE` checks the public format and recomputes technical conditions. `pilot binding FILE --json` produces the exact file and evidence binding for a sharing decision. These tools do not authenticate people, consent, device identity, or external success.

See [publisher quickstart](publisher-pilot-quickstart.md), [private cohort audit](cohort-audit.md), and the blank templates. Keep completed records and raw captures outside version control.
