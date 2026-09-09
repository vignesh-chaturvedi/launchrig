# Prepare a human send decision

`cohort prepare-send-decision` prepares a private request for a later human decision. It requires one selected prospect-review receipt, its unchanged prospect and draft, expected digests, and explicit confirmation of the complete related-review set.

The command verifies exact inputs and rejects additional related receipts or ambiguous selection. It does not select the latest record automatically, establish review-set completeness independently, or authenticate the operator.

Use the full argument list shown in `launchrig --help`. Inputs must be private bounded regular files and output must be a new absolute path outside Git. When any byte changes, re-evaluate the earlier review before preparing a new request.

The result remains a request. It does not authorize a send, contact anyone, create interest, or approve an app or device. The later human decision must recheck the current situation and exact message.

See [send recording](publisher-send-decision-recording.md) for recording that decision. Keep the request, contacts, and draft private.
