# MWA rejection flow guide

Use this guide to promote a distinct publisher-owned `mwa-reject` Maestro flow. Returning from a wallet without proving recovery is not sufficient.

## Preconditions

- The app exposes a real MWA action that the operator can decline in the development wallet.
- The publisher identifies stable resource IDs or accessibility labels for pending, rejected, retry, and healthy states.
- The publisher agrees on the expected user-facing rejection result.
- Wallet rejection remains manual.

## Required behavior

1. Launch the publisher app without clearing state.
2. Trigger the approved MWA request.
3. Allow the operator to reject it in the development wallet.
4. Return to the publisher app.
5. Assert the publisher-owned controlled rejection result.
6. Assert that the pending state is cleared.
7. Assert that a retry or safe navigation path is available.
8. Confirm the app does not remain stuck, crash, or report false success.

The flow should exercise the same product path publishers care about before release. It must not simulate rejection by tapping only inside the dApp.

## Repeatability

Run the flow repeatedly without clearing app or wallet state. Each rejection must leave the app ready for another attempt. Preserve failed attempts in pilot history because a stuck or inconsistent recovery is useful evidence.

## Promotion checklist

- [ ] The promoted filename is not the generated `.example.yaml` file.
- [ ] Every reserved `TODO:` selector was replaced.
- [ ] The flow `appId` matches the configured publisher application ID.
- [ ] The assertions cover rejection, cleared pending state, and retry availability.
- [ ] The flow contains no wallet-screen selector or credential input; the operator handles wallet UI manually.
- [ ] The publisher reviewed every action and assertion.
- [ ] The flow is distinct from the authorize, SIWS, and sign-message definitions.
