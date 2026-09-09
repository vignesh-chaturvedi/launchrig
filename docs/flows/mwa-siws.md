# MWA SIWS flow guide

Use this guide to promote a distinct publisher-owned `mwa-siws` Maestro flow. Ordinary wallet authorization must not be relabeled as Sign In With Solana.

## Preconditions

- The publisher app exposes a genuine SIWS request and a stable authenticated-session marker.
- The approved development wallet supports the app's SIWS path.
- The publisher identifies stable resource IDs or accessibility labels for sign-in, authenticated state, controlled failure, and pending state.
- Wallet authentication and approval remain manual.

## Required behavior

1. Launch the publisher app without clearing state.
2. Navigate to the publisher's sign-in action.
3. Trigger the real SIWS request.
4. Allow the operator to approve it in the development wallet.
5. Return to the publisher app.
6. Assert the publisher-owned authenticated-session marker.
7. Assert that no request remains pending and the app remains usable.

The flow must test the app's actual SIWS integration. A connected wallet address alone is not an authenticated SIWS session.

## Repeatability

The flow must produce a stable outcome on repeat execution. It may confirm an existing session or initiate a new SIWS request according to the publisher's intended product behavior. Record that choice in the private pilot notes.

If the app has no SIWS feature, the session can be a private integration rehearsal but cannot qualify under technical profile `external-mwa-pilot-v1`.

## Promotion checklist

- [ ] The promoted filename is not the generated `.example.yaml` file.
- [ ] Every reserved `TODO:` selector was replaced.
- [ ] The flow `appId` matches the configured publisher application ID.
- [ ] The success marker proves authenticated SIWS state, not only authorization.
- [ ] The flow contains no wallet-screen selector or credential input; the operator handles wallet UI manually.
- [ ] The publisher reviewed every action and assertion.
- [ ] The flow is distinct from the authorize, sign-message, and rejection definitions.
