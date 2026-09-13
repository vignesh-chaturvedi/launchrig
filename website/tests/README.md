# Mobile motion regression checks

This test uses an isolated headless Playwright browser. It never connects to an existing browser profile. Install Playwright and its browser separately, or point the test at an existing installation.

Serve `website/public` on port 4193, then run from the repository root:

```sh
node website/tests/mobile-motion.cjs
node website/tests/website-regression.cjs
```

Optional environment variables:

- `LAUNCHRIG_PREVIEW_URL`: URL under test, default `http://127.0.0.1:4193/`.
- `LAUNCHRIG_PLAYWRIGHT_PATH`: package name or absolute path to an installed Playwright module.
- `LAUNCHRIG_BROWSER_ENGINE`: `chromium` by default, or `webkit` when its Playwright browser is installed.
- `LAUNCHRIG_BROWSER_PATH`: an existing compatible browser executable. Omit to use the installed Playwright engine.
- `LAUNCHRIG_REVIEW_OUTPUT`: screenshot and JSON output directory, default `/tmp/launchrig-mobile-review`.

The suite checks compact-screen scroll motion, card clearance across 41 positions, external legend placement, pause/resume, idle and offscreen writes, Reduce Motion, desktop breakpoint transitions, 200% root text size, touch targets, and no-JavaScript content. The demo link is not activated and no third-party forms are submitted.

The website regression suite additionally checks desktop card sweeps, the demo button's entry and exit transition, keyboard activation with an intercepted destination, color contrast, asset size, and no-JavaScript content. Its output defaults to `/tmp/launchrig-website-review` and it uses Chromium. Both scripts write screenshots and JSON results outside the served `public/` directory.

These are automated viewport checks, not physical iPhone or iOS Safari tests. WebKit is a useful additional engine check, but does not establish behavior on a particular iPhone, iOS version, power mode, or browser toolbar configuration.
