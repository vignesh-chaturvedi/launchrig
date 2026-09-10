# Local Android MWA evidence

This snapshot contains nine normalized reports from one ordinary physical Android device. It records 18 checks across three reference suite passes and three controlled broken/fixed pairs. The controlled failures and their fixed counterparts are local test scenarios; they do not establish defects in external applications.

The evidence is self-recorded and unattested, for supporting technical evidence only. Application eligibility has not been evaluated.

## View the evidence

- [HTML report](bundle/index.html)
- [Normalized proof](bundle/proof.json)
- [Proof schema](bundle/schema.json)
- [Manifest](bundle/manifest.json)
- [Checksums](bundle/SHA256SUMS)

Clone or download the latest version of this repository, extract the download if needed, and open `evidence/local-android-mwa-v2/bundle/index.html` locally. Keep the six bundle files together so the stylesheet is available. GitHub displays the HTML source; this publication does not provide a hosted website.

## Verify file integrity

From the root of your downloaded or cloned repository:

```sh
cd evidence/local-android-mwa-v2/bundle
```

First check the checksum inventory itself. On macOS:

```sh
shasum -a 256 SHA256SUMS
```

On Linux:

```sh
sha256sum SHA256SUMS
```

The result must match this trusted fingerprint before you use the inventory:

```text
8645fe8a6a77ab236d5f0cf3fe7cd8d4f675d8c39fa703bb2d0aefea06728991  SHA256SUMS
```

Compare this value with the value in the publisher's trusted repository snapshot, independently of any third-party copy of the bundle. If it differs, stop: the inventory is not the selected snapshot.

Then verify the files listed in the inventory. On macOS:

```sh
shasum -a 256 -c SHA256SUMS
```

On Linux:

```sh
sha256sum -c SHA256SUMS
```

Every listed file must report `OK`. The bundle contains exactly `SHA256SUMS`, `index.html`, `manifest.json`, `proof.json`, `schema.json`, and `styles.css`. Checksum commands validate the listed files but do not detect additional files.

These checks establish file integrity against the selected snapshot. They do not independently authenticate a phone session, attest to the source reports, or perform semantic validation of the evidence. This repository does not include a standalone semantic proof verifier.

## Snapshot identity

| Identity | Value |
| --- | --- |
| Bundle ID | `sha256:2abad82c99415d792d6fde855564430fb374f878a90d808ca94b187e2abb050f` |
| Canonical proof digest | `36908ca01e8727806253b0570948663b42cf092ea259026f43c34d29f237dd82` |
| SHA-256 of the serialized `proof.json` file | `57da3d523ef15743013fa09354dc5af91ef41311e9cc27936ac8a991949fdf7c` |

The canonical proof digest identifies the canonical proof representation. It is not the hash of the serialized `proof.json` file. Use `SHA256SUMS` to compare the published file bytes.

## Limits of the evidence

This snapshot does not establish independent authenticity, Seeker hardware or Seed Vault testing, on-chain transactions, real production-wallet compatibility, external publisher participation, user adoption, or any grant award. It also does not establish defects in external applications.

The normalized records include source-report fingerprints. Those hashes do not disclose the source reports, but someone who already possesses the matching private bytes can correlate them with these public records.
