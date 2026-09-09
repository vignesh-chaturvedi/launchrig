# MWA sign-message flow guide

Use this guide to promote a distinct publisher-owned `mwa-sign-message` Maestro flow. This scenario signs a harmless fixed message, not a transaction.

## Preconditions

- The app exposes its real MWA message-signing path.
- The message is fixed, nonsecret, nontransactional, and approved by the publisher.
- The publisher identifies stable resource IDs or accessibility labels for the signing action, success state, controlled failure, and pending state.
- Wallet authentication and signing approval remain manual.

## Required behavior

1. Launch the publisher app without clearing state.
2. Reach the message-signing action in a stable connected state.
3. Trigger the fixed harmless message request.
4. Allow the operator to approve it in the development wallet.
5. Return to the publisher app.
6. Assert an explicit publisher-owned signing-success marker.
7. Assert that no request remains pending and retry or navigation remains available.

Do not infer success merely because the wallet closed. The app must display a stable result derived from its handled signing response.

## Repeatability

Repeat execution must not depend on a changing timestamp, random message, valuable account, or state clearing. If the product intentionally prevents duplicate messages, use a deterministic publisher-approved reset within the allowed UI flow and document it privately.

## Promotion checklist

- [ ] The promoted filename is not the generated `.example.yaml` file.
- [ ] Every reserved `TODO:` selector was replaced.
- [ ] The flow `appId` matches the configured publisher application ID.
- [ ] The message is harmless and contains no credential or private publisher data.
- [ ] The flow contains no wallet-screen selector or credential input; the operator handles wallet UI manually.
- [ ] The publisher reviewed every action and assertion.
- [ ] The flow is distinct from the authorize, SIWS, and rejection definitions.
