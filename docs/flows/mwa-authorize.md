# MWA authorize flow guide

Use this guide to promote a distinct publisher-owned `mwa-authorize` Maestro flow. Do not run the generated example unchanged.

## Preconditions

- The approved test app and allowlisted development wallet are installed.
- The app targets devnet or testnet and uses a nonvaluable test account.
- The publisher identifies stable resource IDs or accessibility labels for the connect action, connected state, and error state.
- Wallet authentication and approval remain manual.

## Required behavior

1. Launch the publisher app without clearing app or wallet state.
2. Wait for the stable disconnected or ready state.
3. Trigger a real MWA authorization request.
4. Allow the operator to approve it in the development wallet.
5. Return to the publisher app.
6. Assert a stable connected state owned by the publisher app.
7. Assert that no request remains pending and the main UI remains usable.

The assertion must prove more than a wallet app opening. Use a publisher-owned connected-state marker, not wallet text that may change between wallet releases.

## Repeatability

Run the same flow again without clearing state. The app may reauthorize or reuse a valid authorization, but it must return to the same stable connected state. If repeat execution needs a separate disconnect step, keep that behavior inside the reviewed flow using only LaunchRig's allowed Maestro commands.

## Promotion checklist

- [ ] The promoted filename is not the generated `.example.yaml` file.
- [ ] Every reserved `TODO:` selector was replaced.
- [ ] The flow `appId` matches the configured publisher application ID.
- [ ] The flow does not clear state, invoke an external file, capture the screen, or use host interpolation.
- [ ] The flow contains no wallet-screen selector or credential input; the operator handles wallet UI manually.
- [ ] The publisher reviewed every action and assertion.
- [ ] The flow is distinct from the SIWS, sign-message, and rejection definitions.
