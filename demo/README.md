# LaunchRig: controlled Android wallet recovery

https://github.com/user-attachments/assets/ffc9650b-b944-49c9-a24a-7e2b540c6f27

[Watch or download the 1080p MP4](launchrig-demo.mp4) · [Download captions](launchrig-demo.srt)

A 90-second walkthrough of published, self-recorded Android and Mobile Wallet Adapter evidence. This video shows the report and explains public fixture source contracts. It is not live phone execution or reconstructed wallet footage.

The snapshot contains three reference suite passes and three deliberately broken/fixed recovery pairs: rejection, stale authorization, and dApp process death. Nine reports contain 18 scenario checks. The expected broken failures stay failed.

The phone profile is an ordinary Android 12/API 31 device. Reference test-wallet runs use testnet; controlled Mock MWA cases use devnet. The interrupted process-death signing outcome remains unknown.

These results do not establish independent authenticity, production-wallet compatibility, Seeker or Seed Vault validation, on-chain execution, external publisher adoption, defects in external apps, or a grant award. Checksums verify file integrity against the selected published snapshot, not independent authenticity or semantic correctness.

- [Inspect LaunchRig source and evidence](https://github.com/vignesh-chaturvedi/launchrig)
- [Pinned normalized evidence and checksum guide](https://github.com/vignesh-chaturvedi/launchrig/tree/07160c9e71fa90a5723dbc3da5e42a2cd439996c/evidence/local-android-mwa-v2)
- [Pinned controlled recovery case study](https://github.com/vignesh-chaturvedi/launchrig/blob/14bf99da7de198a605637dc3452cc4ff151e8e29/case-studies/android-wallet-recovery.md)

The sound effects are editorial cues synthesized for this walkthrough, not recorded device audio. Captions are included; no narration or music is used.

## File integrity

The video is 90 seconds, 1920 by 1080, 30 fps, H.264/AAC. Run this from this directory to compare the three media files with the published inventory:

```sh
shasum -a 256 -c SHA256SUMS
```

The source-preview `v0.1.0` tag and its immutable release are unchanged. These demonstration assets are not a new product binary release.
