# Core runner and controlled recovery

The legacy filename identifies the core runner documentation in the package inventory.

`init` creates a starter configuration without silently overwriting an existing one. `validate` checks schema, network, wallet, privacy, artifacts, and flow policy. `doctor` inspects a selected Android environment. `run` executes selected scenarios sequentially and writes reports. `matrix` evaluates the controlled lifecycle regression contract.

The controlled fixture includes wallet rejection, stale authorization, and dApp process-death recovery. Each case has a broken and fixed variant. Acceptance requires the broken variant to fail at its designated state and the fixed variant to pass. Missing artifacts, unrelated required failures, or changed paired flows invalidate acceptance.

A successful matrix does not turn broken runs into passes. Each report preserves its actual outcome. A recovery result of `UNKNOWN` does not guess whether the interrupted wallet operation succeeded.

Reference MWA authorization, SIWS, harmless message signing, and rejection recovery are separate from transaction submission. Source tests use doubles and do not establish physical wallet behavior.

See [device setup](physical-device.md), [supported environment](supported-environment.md), and the root README for execution commands. Source builds and local reports remain distinct from released or externally attested artifacts.
