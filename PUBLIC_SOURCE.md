# Source scope

This checkout contains the LaunchRig product and controlled fixture source. Its history is a filtered reconstruction of product development. Original author dates are retained, commit IDs change, and commits with no exported product changes are omitted. Documentation was added separately after review. Commit metadata uses the maintainer's GitHub noreply address. This is not the original unfiltered repository history.

The checkout includes no recorded phone reports, APKs, wallet data, completed operator records, or application material. Tests create synthetic input in temporary directories. Two optional cached-APK checks skip when the local binaries are absent. A skipped binary check does not establish an artifact or physical-device result.

## Local verification

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm package:smoke
```

The fixture app has a separate dependency tree. Install it only for fixture development:

```bash
pnpm --dir apps/fixture-dapp install --frozen-lockfile
pnpm --dir apps/fixture-dapp test
```

No phone is needed for these commands. Run `doctor`, `run`, or `matrix` only after reviewing the selected device configuration. See [device setup](docs/physical-device.md), [supported environment](docs/supported-environment.md), and [configuration validation](docs/config-v1-compatibility.md).

## API compatibility

The schemas retain existing field names, including `grantReady`, `grantMilestoneComplete`, and `pre-award-foundation`. These are versioned technical fields. Their current values remain false or explicitly limited; source publication does not alter their meaning or assert an award, third-party adoption, or hardware qualification.

Some documentation paths retain `phase-1`, `phase-2`, and `phase-3` names because package verification includes them in its versioned inventory. They describe technical capabilities and limitations, not a delivery schedule.

MIT notices and upstream fixture attribution are retained. The npm package remains private until a separate package release is prepared. This source snapshot does not include a hosted binary or a production support promise.
