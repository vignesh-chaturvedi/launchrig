# Record an exact prospect review

`cohort record-prospect-review` records a human review of one private prospect file and one exact draft. It requires a named operator reference, expected digests, explicit findings, a compatible decision and reason, and deliberate confirmation. See `launchrig --help` for the complete argument contract.

Both inputs must be separate bounded regular mode-600 files. Keep them outside Git. The output must be a new absolute path outside any detected Git worktree; existing records are not overwritten. A changed input requires a new review of its new bytes.

The strict schemas bind the decision to exact content and validate permitted finding combinations. Output omits paths and private values. The receipt records a human assertion, not an authenticated identity or signature.

A positive review does not send the draft, authorize contact, establish interest, or approve a project or phone. Contact remains `not-contacted` and send authorization remains `not-authorized`. Prepare a separate send decision only when the actual operator intends to review one.

See [send preparation](publisher-send-decision-preparation.md). Keep every completed input and receipt private even if a later message is authorized.
