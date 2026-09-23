# LaunchRig Android Preview

This is a small, separate Android companion for LaunchRig's grant application. It shows the selected Ion Wing mark, project status, the public grant deck, and links to the demo and evidence. It does not connect a wallet or run LaunchRig tests. The existing fixture app under `apps/fixture-dapp` remains controlled test input and is not this product.

## Build

Requirements: Android SDK platform 35 and build tools 36, JDK 17 or newer, Gradle 9.5 or newer, and Android Gradle Plugin 9.3.1. The project has no third-party runtime libraries.

```bash
cd apps/launchrig-preview
ANDROID_HOME=/path/to/android-sdk gradle --no-daemon :app:assembleDebug
```

The debug APK is at `app/build/outputs/apk/debug/app-debug.apk`. It is for local review only. It is not a signed store release.

To install after a phone is connected and USB debugging is authorized:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n dev.launchrig.preview/.MainActivity
```

The overview is offline-capable. The deck, demo, source, and evidence need a network connection. Deck WebView navigation is restricted to the public LaunchRig deck route; other HTTPS links open the device browser. The app requests only Internet permission.

## Verify before describing it in the grant form

- Check icon and title in the Android launcher.
- Scroll the native overview at normal and enlarged text size.
- Open the grant deck, navigate slides, use the back button, and test no-network behavior.
- Open public demo, source, and evidence links in the browser.
- Confirm the app never claims to run tests, connect a wallet, or validate a Seeker.

Do not count a successful compile as physical-device validation.
