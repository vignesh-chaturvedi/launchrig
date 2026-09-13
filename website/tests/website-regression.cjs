const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const playwrightPath = process.env.LAUNCHRIG_PLAYWRIGHT_PATH || 'playwright';
const { chromium } = require(playwrightPath);
const output = process.env.LAUNCHRIG_REVIEW_OUTPUT || '/tmp/launchrig-website-review';
const url = process.env.LAUNCHRIG_PREVIEW_URL || 'http://127.0.0.1:4193/';
const siteDirectory = process.env.LAUNCHRIG_SITE_DIRECTORY || path.join(__dirname, '../public');

async function cardClearance(page, sweep = false) {
  return page.evaluate(async sweep => {
    const stage = document.querySelector('.stage');
    const visual = document.querySelector('.visual');
    const sequence = document.querySelector('.sequence');
    const origin = sequence.getBoundingClientRect().top + scrollY;
    const distance = sequence.offsetHeight - innerHeight + 80;
    const minimum = { left: Infinity, right: Infinity, top: Infinity, bottom: Infinity };
    const ticks = sweep ? 40 : 0;
    const pointers = sweep ? [[.5, .5], [0, 0], [1, 0], [0, 1], [1, 1]] : [[.5, .5]];
    for (let tick = 0; tick <= ticks; tick++) {
      if (sweep) scrollTo(0, origin - 80 + distance * tick / ticks);
      for (const [x, y] of pointers) {
        const v = visual.getBoundingClientRect();
        visual.dispatchEvent(new PointerEvent('pointermove', { clientX: v.left + x * v.width, clientY: v.top + y * v.height }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const s = stage.getBoundingClientRect();
        for (const plane of document.querySelectorAll('.plane')) {
          const p = plane.getBoundingClientRect();
          minimum.left = Math.min(minimum.left, p.left - s.left);
          minimum.right = Math.min(minimum.right, s.right - p.right);
          minimum.top = Math.min(minimum.top, p.top - s.top);
          minimum.bottom = Math.min(minimum.bottom, s.bottom - p.bottom);
        }
      }
    }
    visual.dispatchEvent(new PointerEvent('pointerleave'));
    return { samples: (ticks + 1) * pointers.length, minimum };
  }, sweep);
}

function assertClearance(result, label) {
  for (const [edge, gap] of Object.entries(result.minimum)) {
    assert.ok(gap >= 6, `${label}: ${edge} clearance ${gap.toFixed(2)}px must include card shadows`);
  }
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.LAUNCHRIG_BROWSER_PATH ? { executablePath: process.env.LAUNCHRIG_BROWSER_PATH } : {}) });
  const results = { generatedAt: new Date().toISOString(), checks: [], performanceScope: 'Local browser and asset checks only. No physical Android, slow-network or low-RAM qualification.' };
  const sizes = [375, 768, 1280];
  try {
    for (const width of sizes) {
      const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'no-preference' });
      const page = await context.newPage();
      const errors = [];
      const requests = [];
      page.on('pageerror', err => errors.push(err.message));
      page.on('request', req => requests.push(req.url()));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(url, { waitUntil: 'networkidle' });
      assert.equal(await page.title(), 'LaunchRig | Inspect the return path');
      assert.equal(await page.locator('h1').count(), 1);
      const logos = page.locator('.wordmark img');
      assert.equal(await logos.count(), 2);
      assert.equal(await logos.evaluateAll(nodes => nodes.every(img => img.complete && img.naturalWidth > 0 && img.hasAttribute('width') && img.hasAttribute('height') && img.alt === '')), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(requests.every(request => request.startsWith(url)), true);
      const smallTargets = await page.locator('a, button:not([hidden])').evaluateAll(nodes => nodes.filter(node => {
        const b = node.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && (b.width < 40 || b.height < 40);
      }).map(node => node.textContent.trim()));
      assert.deepEqual(smallTargets, []);
      assertClearance(await cardClearance(page), `Initial ${width}px`);
      await page.screenshot({ path: path.join(output, `desktop-${width}.png`), fullPage: false });
      if (width === 1280) {
        const rig = page.locator('.rig');
        const first = await rig.getAttribute('style');
        await page.locator('[data-stage="1"]').click();
        await page.waitForFunction(first => document.querySelector('.rig').getAttribute('style') !== first, first);
        const second = await rig.getAttribute('style');
        await page.screenshot({ path: path.join(output, 'interrupt.png') });
        await page.locator('[data-stage="2"]').click();
        await page.waitForFunction(second => document.querySelector('.rig').getAttribute('style') !== second, second);
        await page.screenshot({ path: path.join(output, 'inspect.png') });
        await page.getByRole('button', { name: 'Pause motion' }).click();
        const frozen = await rig.getAttribute('style');
        await page.locator('[data-stage="1"]').click();
        await page.waitForTimeout(250);
        assert.equal(await rig.getAttribute('style'), frozen);
        assert.equal(await page.locator('[data-stage="1"]').getAttribute('aria-current'), 'step');
        await page.getByRole('button', { name: 'Resume motion' }).click();
        await page.waitForTimeout(100);
        const idleWrites = await page.evaluate(() => new Promise(resolve => {
          let writes = 0;
          const observer = new MutationObserver(records => { writes += records.length; });
          observer.observe(document.querySelector('.rig'), { attributes: true });
          setTimeout(() => { observer.disconnect(); resolve(writes); }, 300);
        }));
        assert.equal(idleWrites, 0);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.waitForFunction(() => !document.documentElement.classList.contains('motion-enabled'));
        assert.equal(await page.locator('html').evaluate(el => el.classList.contains('motion-enabled')), false);
        assert.equal(await page.locator('#motion-toggle').isVisible(), false);
        await page.goto(url);
        await page.screenshot({ path: path.join(output, 'reduced-motion.png') });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.goto(url);
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Skip to content');
        const focus = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
        assert.notEqual(focus, 'none');
        results.checks.push({ desktopMotion: 'Scroll changes pose; pause freezes it; resume works; zero rig writes while idle; reduced-motion toggle removes motion; keyboard skip link has visible focus.' });
      }
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      assertClearance(await cardClearance(page), `Enlarged text ${width}px`);
      await page.screenshot({ path: path.join(output, `text-200-${width}.png`), fullPage: true });
      const overflow = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, nodes: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth && !el.closest('.stage')).map(el => ({ tag: el.tagName, className: el.className, right: el.getBoundingClientRect().right })) }));
      assert.equal(overflow.scrollWidth <= width, true, `Text enlargement overflow at ${width}px: ${JSON.stringify(overflow)}`);
      const metricBounds = await page.locator('.numbers dd').evaluateAll(nodes => nodes.map(node => ({ right: node.getBoundingClientRect().right, containerRight: node.parentElement.getBoundingClientRect().right, scrollWidth: node.scrollWidth, width: node.clientWidth })));
      assert.equal(metricBounds.every(metric => metric.scrollWidth <= metric.width && metric.right <= metric.containerRight + 1), true, 'Metric values must not overlap at enlarged text sizes');
      assert.deepEqual(errors, []);
      results.checks.push({ width, horizontalOverflow: false, consoleErrors: errors, requests: requests.filter((v,i,a) => a.indexOf(v) === i), touchTargets: 'At least 40 by 40 CSS pixels', textEnlargement: '200% root font size, no page overflow' });
      await context.close();
    }
    for (const width of [1001, 1082, 1280, 1920]) {
      const context = await browser.newContext({ viewport: { width, height: 800 } });
      const page = await context.newPage();
      await page.goto(url);
      const clearance = await cardClearance(page, true);
      assertClearance(clearance, `Scroll sweep ${width}px`);
      results.checks.push({ scrollBounds: { width, ...clearance } });
      if (width === 1280) {
        await page.evaluate(() => {
          const sequence = document.querySelector('.sequence');
          scrollTo(0, sequence.getBoundingClientRect().top + scrollY - 80 + (sequence.offsetHeight - innerHeight + 80) / 2);
        });
        await page.waitForTimeout(100);
        await page.screenshot({ path: path.join(output, 'middle-pose-clearance.png') });
      }
      await context.close();
    }
    const ctaContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const ctaPage = await ctaContext.newPage();
    await ctaPage.goto(url);
    const demo = ctaPage.getByRole('link', { name: 'Watch the 90-second demo', exact: true });
    assert.equal(await demo.count(), 1, 'Only one accessible label, despite the masked visual duplicate');
    assert.equal(await demo.getAttribute('href'), 'https://github.com/vignesh-chaturvedi/launchrig#watch-the-90-second-demo');
    const fill = demo.locator('.demo-fill');
    const restingClip = await fill.evaluate(el => getComputedStyle(el).clipPath);
    const restingBounds = await demo.boundingBox();
    await demo.screenshot({ path: path.join(output, 'demo-rest.png') });
    for (let entry = 0; entry < 2; entry++) {
      await demo.hover();
      const partial = await fill.evaluate(el => {
        const transition = el.getAnimations().find(animation => animation.transitionProperty === 'clip-path');
        if (!transition) return null;
        transition.pause();
        transition.currentTime = 80;
        return { duration: transition.effect.getTiming().duration, clip: getComputedStyle(el).clipPath };
      });
      assert.ok(partial && partial.clip !== restingClip, 'Hover must progressively expand the dot');
      assert.equal(partial.duration, 200);
      assert.deepEqual(await demo.boundingBox(), restingBounds, 'The button must not shift the layout');
      if (entry === 0) {
        await demo.screenshot({ path: path.join(output, 'demo-partial.png') });
        await fill.evaluate(el => el.getAnimations().forEach(animation => animation.play()));
        await ctaPage.waitForTimeout(350);
        assert.equal(await demo.locator('.demo-icon').evaluate(el => getComputedStyle(el).opacity), '1');
        assert.equal(await fill.evaluate(el => getComputedStyle(el).clipPath), 'inset(0px round 999px)');
        await demo.screenshot({ path: path.join(output, 'demo-hover.png') });
        assert.equal(await demo.evaluate(el => el.getAnimations({ subtree: true }).length), 0, 'Held hover must not loop');
      }
      await ctaPage.mouse.move(0, 0);
      await ctaPage.waitForTimeout(300);
      assert.equal(await fill.evaluate(el => getComputedStyle(el).clipPath), restingClip, 'Exit, including a partial entry, must settle back to the dot');
    }
    const cdp = await ctaContext.newCDPSession(ctaPage);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await demo.hover();
    await ctaPage.waitForTimeout(400);
    assert.equal(await fill.evaluate(el => getComputedStyle(el).clipPath), 'inset(0px round 999px)');
    await ctaPage.mouse.move(0, 0);
    await ctaPage.waitForTimeout(400);
    assert.equal(await fill.evaluate(el => getComputedStyle(el).clipPath), restingClip);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdp.detach();
    await ctaPage.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await fill.evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    assert.equal(await fill.evaluate(el => getComputedStyle(el).clipPath), 'inset(0px round 999px)');
    await demo.screenshot({ path: path.join(output, 'demo-reduced-motion.png') });
    await ctaPage.keyboard.press('Tab');
    await demo.focus();
    assert.equal(await demo.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    const destination = await demo.getAttribute('href');
    await ctaPage.route(destination, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Demo destination check</title>' }));
    await ctaPage.keyboard.press('Enter');
    await ctaPage.waitForURL(destination);
    results.checks.push({ demoCTA: '200 ms dot-to-fill transition; resting, partial, held and repeated hover verified; partial entry reverses; icon settles; no layout shift or idle loop; one accessible label; keyboard navigation verified with intercepted destination; touch and reduced motion stay fully filled.', cpuThrottle: 'Entry and exit settle correctly at 4x CPU throttle. Not a frame-rate or physical-device qualification.' });
    await ctaContext.close();
    const touchContext = await browser.newContext({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });
    const touchPage = await touchContext.newPage();
    await touchPage.goto(url);
    assertClearance(await cardClearance(touchPage), '320px touch');
    await touchPage.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    assertClearance(await cardClearance(touchPage), '320px touch enlarged text');
    assert.equal(await touchPage.locator('.demo-fill').evaluate(el => getComputedStyle(el).clipPath), 'inset(0px round 999px)');
    assert.equal(await touchPage.locator('.demo-fill').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    results.checks.push({ narrowTouch: '320px card bounds fit at normal and 200% text; no touch hover animation.' });
    await touchContext.close();
    const shortContext = await browser.newContext({ viewport: { width: 1440, height: 600 } });
    const shortPage = await shortContext.newPage();
    await shortPage.goto(url);
    assert.equal(await shortPage.locator('.visual').evaluate(el => getComputedStyle(el).position), 'relative');
    assert.equal(await shortPage.locator('#motion-toggle').isVisible(), true);
    assertClearance(await cardClearance(shortPage), 'Short-screen compact composition');
    results.checks.push({ shortScreen: '1440 by 600 uses an unpinned, compact scroll-enabled composition so controls remain reachable.' });
    await shortContext.close();
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(url);
    assert.equal(await page.getByRole('link', { name: 'Open the evidence package' }).count(), 1);
    assert.equal(await page.locator('#motion-toggle').isVisible(), false);
    await page.screenshot({ path: path.join(output, 'no-js.png') });
    results.checks.push({ noJavaScript: 'Content, evidence links and static diagram remain available; motion button hidden.' });
    await context.close();
    results.assets = ['index.html', 'styles.css', 'motion.js', ...fs.readdirSync(path.join(siteDirectory, 'assets')).map(file => `assets/${file}`)].map(file => {
      const bytes = fs.readFileSync(path.join(siteDirectory, file));
      if (!file.startsWith('assets/')) assert.equal(bytes.includes(Buffer.from('\u2014')), false, `Em dash in ${file}`);
      return { file, bytes: bytes.length, gzipBytes: zlib.gzipSync(bytes).length };
    });
    const linear = value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    const luminance = hex => hex.match(/[0-9a-f]{2}/gi).map(part => linear(parseInt(part, 16) / 255)).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
    results.contrast = [];
    for (const fg of ['#f0f3f8', '#aab4c2', '#93c5fd', '#92dcb4', '#ffaeaa', '#f0ce87']) {
      for (const bg of ['#101216', '#181c22', '#202833']) {
        const ratio = (luminance(fg) + .05) / (luminance(bg) + .05);
        assert.ok(ratio >= 4.5, `${fg} on ${bg}`);
        results.contrast.push({ foreground: fg, background: bg, ratio: Number(ratio.toFixed(2)) });
      }
    }
    assert.ok((luminance('#93c5fd') + .05) / (luminance('#102039') + .05) >= 4.5);
    results.status = 'passed';
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
