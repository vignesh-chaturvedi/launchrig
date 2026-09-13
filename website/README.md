# LaunchRig website

Static product website with the approved Ion Wing mark, Graphite / Arctic Blue palette, scroll-driven recovery diagram, and dot-to-fill demo button.

Only `public/` is served. No package installation, build, server functions, environment variables, remote fonts, analytics, or wallet connection are required. The website links to the existing public demo and evidence; it does not download the video on initial load.

## Deploy later with Vercel

Import `vignesh-chaturvedi/launchrig` from GitHub and use:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root Directory | `website` |
| Framework Preset | Other |
| Build Command | Empty |
| Install Command | Empty |
| Output Directory | `public` |

The adjacent `vercel.json` supplies the build, install, framework, and output settings. Select `website` as the root in Vercel when importing the repository. Do not use the repository root, which contains the separate CLI project.

No Vercel project has been created or deployed by this source update. Once connected, pushes to the configured production branch can trigger production deployments. Use a preview branch for future design changes before merging.

See [Vercel build configuration](https://vercel.com/docs/builds/configure-a-build).

## Preview locally

From the repository root:

```sh
python3 -m http.server 4183 --bind 127.0.0.1 --directory website/public
```

Open `http://127.0.0.1:4183/`. This serves only the website assets.

## Motion and evidence limits

Desktop scrolling changes the illustrative card poses; fine-pointer movement adds limited tilt. Small and short screens use compact poses linked to scrolling while the diagram is visible, with a separate label row and no sticky scrolling. The pause control freezes the diagram at every screen size. The demo button adapts the dot-to-fill technique in [Denys Sergushkin's CTA reference](https://dribbble.com/shots/23115628-Interaction-with-CTA), using LaunchRig colors and unchanged demo copy. Reference media is not included.

Reduced-motion users receive static controls. Navigation remains usable without JavaScript. There is no perpetual rendering loop.

The diagram is illustrative, not a live device session. Linked evidence is self-recorded and unattested from an ordinary Android device using development wallets and controlled fixtures. It does not establish Seeker, Seed Vault, production-wallet compatibility, on-chain execution, or external adoption. Website branding does not change the Android fixture icon.

## File inventory

- `public/index.html`: page content and local asset links.
- `public/styles.css`: visual styling, card containment, and accessible CTA transition.
- `public/motion.js`: event-driven diagram updates.
- `public/assets/ion-wing.webp`: approved transparent logo, reused in the header, footer, favicon, and repository README.
- `vercel.json`: static-hosting settings, without an account or project identifier.

Review the page at mobile, tablet, desktop, reduced motion, and enlarged text sizes when changing these files. Keep the evidence limits and public destinations intact.
