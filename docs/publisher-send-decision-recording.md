# Record a human send decision

`cohort record-send-decision` records a deliberate human decision on one exact prepared request and its bound review, prospect, and draft. It requires an authorizer reference, expected digests, five current rechecks, a supported decision and reason, and confirmation.

Use `launchrig --help` and the versioned decision schemas for the required arguments and permitted combinations. Inputs and the new output are private files outside Git. The command rejects changed or unrelated inputs and does not overwrite a receipt.

A positive decision covers only the exact reviewed draft within the command's limited validity window. Nonpositive outcomes preserve the recorded refusal or deferral. An operator must check that the receipt still applies immediately before any manual send.

Every result keeps `messageDispatched` false and contact `not-contacted`. This command has no transport integration and sends nothing. It does not authenticate the authorizer, establish recipient interest, authorize device testing, or publish evidence.

Record an actual response separately if a human later sends the authorized message. Project installation, exact device scope, and evidence sharing remain separate permission decisions.
