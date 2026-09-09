# Physical Android setup

Start with an ordinary Android phone on API 26 or later, Android Platform Tools, and a USB cable that supports data. Enable Developer options and USB debugging. Unlock the phone and accept the computer's debugging authorization.

Use `adb devices` locally to check the connection. `unauthorized` requires the phone owner's approval. An offline device requires a connection check. LaunchRig refuses ambiguous device selection when more than one phone is available; pass `--device SERIAL` for the intended phone. Do not commit the serial.

From a built source checkout:

```bash
node dist/src/cli.js doctor --config launchrig.yml
```

The controlled profiles pin Maestro 2.8.0 at `.launchrig/tools/maestro-2.8.0/maestro/bin/maestro`. A custom project may configure its own supported path. Do not edit the controlled matrix profiles casually: their bytes are part of its integrity contract.

`doctor` inspects readiness. Running a suite can replace configured test APKs and operate their UI. Review installation policy, package identities, flows, and capture settings before executing:

```bash
node dist/src/cli.js run --config launchrig.yml
```

Use test accounts without valuable assets. Wallet credentials and biometric prompts belong to the phone owner. Real-wallet mode disables automation and installation. An ordinary Android run does not establish Seeker hardware or Seed Vault behavior.

Logs and captures are local under `.launchrig/`. Review visible content before sharing. Disconnect the phone after an attended test session and revoke debugging authorization if appropriate.
