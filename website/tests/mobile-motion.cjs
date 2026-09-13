const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const playwright = require(process.env.LAUNCHRIG_PLAYWRIGHT_PATH || 'playwright');
const engine = process.env.LAUNCHRIG_BROWSER_ENGINE || 'chromium';
const url = process.env.LAUNCHRIG_PREVIEW_URL || 'http://127.0.0.1:4193/';
const output = process.env.LAUNCHRIG_REVIEW_OUTPUT || '/tmp/launchrig-mobile-review';
const results = {
  generatedAt: new Date().toISOString(),
  url,
  engine,
  scope: 'Automated browser viewport and touch emulation. Not a physical iPhone, iOS Safari, Android, or frame-rate qualification.',
  checks: []
};

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}

async function pose(page) {
  return page.locator('.rig, .app-plane, .wallet-plane, .report-plane').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).transform));
}

async function positionStage(page, top) {
  await page.locator('.stage').evaluate((stage, top) => scrollTo(0, scrollY + stage.getBoundingClientRect().top - top), top);
  await settle(page);
}

async function layout(page, label, mobile = true) {
  const state = await page.evaluate(() => {
    const rect = node => {
      const b = node.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
    };
    const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    const collisions = [];
    for (const selector of ['.visual-bar', '.stage-nav', '.mobile-legend']) {
      const parent = document.querySelector(selector);
      const children = parent && visible(parent) ? [...parent.children].filter(visible) : [];
      for (let i = 0; i < children.length; i++) {
        for (let j = i + 1; j < children.length; j++) {
          if (overlaps(rect(children[i]), rect(children[j]))) collisions.push(`${selector}: ${i} overlaps ${j}`);
        }
      }
    }
    const legend = document.querySelector('.mobile-legend');
    const stage = document.querySelector('.stage');
    const smallTargets = [...document.querySelectorAll('a, button')].filter(visible).filter(node => {
      const b = rect(node);
      return b.width < 40 || b.height < 40;
    }).map(node => ({ text: node.textContent.trim(), ...rect(node) }));
    return {
      viewport: innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflowNodes: [...document.querySelectorAll('body *')].filter(node => visible(node) && !node.closest('.stage') && rect(node).right > document.documentElement.clientWidth + 1).map(node => ({ tag: node.tagName, className: node.className, right: rect(node).right })),
      collisions,
      smallTargets,
      legendVisible: Boolean(legend && visible(legend)),
      legendGap: legend && visible(legend) ? rect(legend).top - rect(stage).bottom : null,
      floatingLabelsVisible: [...document.querySelectorAll('.axis-label')].some(visible),
      visualPosition: getComputedStyle(document.querySelector('.visual')).position
    };
  });
  const expectedWidth = page.viewportSize().width;
  assert.ok(state.scrollWidth <= expectedWidth && state.viewport <= expectedWidth, `${label}: horizontal page overflow or mobile auto-scaling at ${expectedWidth}px: ${JSON.stringify(state)}`);
  assert.deepEqual(state.smallTargets, [], `${label}: every visible link and button must be at least 40 by 40 CSS pixels`);
  assert.deepEqual(state.collisions, [], `${label}: controls and legend items must not overlap`);
  if (mobile) {
    assert.equal(state.visualPosition, 'relative', `${label}: diagram must not pin on compact screens`);
    assert.equal(state.legendVisible, true, `${label}: separate mobile legend must be visible`);
    assert.equal(state.floatingLabelsVisible, false, `${label}: floating axis labels must be hidden`);
    assert.ok(state.legendGap >= 0, `${label}: legend overlaps the stage by ${-state.legendGap}px`);
  }
  return state;
}

async function sweep(page, label, requireMotion = true) {
  const data = await page.evaluate(async () => {
    const stage = document.querySelector('.stage');
    const rig = document.querySelector('.rig');
    const origin = stage.getBoundingClientRect().top + scrollY;
    const height = stage.getBoundingClientRect().height;
    const minimum = { left: Infinity, right: Infinity, top: Infinity, bottom: Infinity };
    const transforms = new Set();
    const styles = new Set();
    const visibleTransforms = new Set();
    const samples = 41;
    for (let sample = 0; sample < samples; sample++) {
      const top = innerHeight - 1 - (innerHeight + height - 2) * sample / (samples - 1);
      scrollTo(0, origin - top);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const s = stage.getBoundingClientRect();
      const value = [rig, ...document.querySelectorAll('.plane')].map(node => getComputedStyle(node).transform).join('|');
      transforms.add(value);
      styles.add(rig.getAttribute('style'));
      if (s.top < innerHeight && s.bottom > 0) visibleTransforms.add(value);
      for (const plane of document.querySelectorAll('.plane')) {
        const p = plane.getBoundingClientRect();
        minimum.left = Math.min(minimum.left, p.left - s.left);
        minimum.right = Math.min(minimum.right, s.right - p.right);
        minimum.top = Math.min(minimum.top, p.top - s.top);
        minimum.bottom = Math.min(minimum.bottom, s.bottom - p.bottom);
      }
    }
    return { samples, minimum, transformCount: transforms.size, visibleTransformCount: visibleTransforms.size, styleCount: styles.size };
  });
  for (const [edge, gap] of Object.entries(data.minimum)) {
    assert.ok(gap >= 6, `${label}: ${edge} card clearance ${gap.toFixed(2)}px must leave 6px for shadows: ${JSON.stringify(data)}`);
  }
  if (requireMotion) assert.ok(data.visibleTransformCount >= 10, `${label}: actual visible transforms must animate across the stage, got ${JSON.stringify(data)}`);
  else assert.equal(data.transformCount, 1, `${label}: diagram must stay static`);
  return data;
}

async function writesWhileIdle(page) {
  await settle(page);
  return page.evaluate(() => new Promise(resolve => {
    let writes = 0;
    const observer = new MutationObserver(records => { writes += records.length; });
    observer.observe(document.querySelector('.rig'), { attributes: true });
    setTimeout(() => { observer.disconnect(); resolve(writes); }, 300);
  }));
}

async function motionControls(page) {
  await positionStage(page, 120);
  assert.equal(await page.locator('#motion-toggle').isVisible(), true);
  await page.getByRole('button', { name: 'Pause motion', exact: true }).click();
  await settle(page);
  const frozen = await pose(page);
  assert.equal(await page.locator('#motion-toggle').getAttribute('aria-pressed'), 'true');
  await positionStage(page, 30);
  assert.deepEqual(await pose(page), frozen, 'Pause must freeze the visible card transforms during scrolling');
  assert.equal(await writesWhileIdle(page), 0, 'Paused rig must not rewrite styles while idle');
  await page.getByRole('button', { name: 'Resume motion', exact: true }).click();
  await positionStage(page, 220);
  assert.notDeepEqual(await pose(page), frozen, 'Resume must respond to the current scroll position');
  assert.equal(await page.locator('#motion-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(await writesWhileIdle(page), 0, 'Enabled rig must not have a perpetual animation loop');
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await settle(page);
  const offscreen = await pose(page);
  const offscreenWrites = await page.evaluate(() => new Promise(resolve => {
    let writes = 0;
    const observer = new MutationObserver(records => { writes += records.length; });
    observer.observe(document.querySelector('.rig'), { attributes: true });
    scrollBy(0, -40);
    setTimeout(() => { observer.disconnect(); resolve(writes); }, 300);
  }));
  assert.equal(offscreenWrites, 0, 'An offscreen diagram must not rewrite rig styles on scroll');
  assert.deepEqual(await pose(page), offscreen, 'Offscreen card transforms must remain unchanged');
  return { pauseResume: 'passed', idleWrites: 0, offscreenWrites };
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  assert.ok(playwright[engine], `Unknown Playwright engine ${engine}`);
  const browser = await playwright[engine].launch({ headless: true, ...(process.env.LAUNCHRIG_BROWSER_PATH ? { executablePath: process.env.LAUNCHRIG_BROWSER_PATH } : {}) });
  results.browserVersion = browser.version();
  try {
    for (const viewport of [{ width: 402, height: 874 }, { width: 430, height: 932 }, { width: 375, height: 812 }, { width: 320, height: 740 }, { width: 600, height: 800 }, { width: 601, height: 800 }, { width: 768, height: 1024 }, { width: 852, height: 393 }]) {
      const label = `${viewport.width}x${viewport.height}`;
      const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(url, { waitUntil: 'networkidle' });
      assert.equal(await page.title(), 'LaunchRig | Inspect the return path');
      assert.equal(await page.locator('h1').count(), 1);
      assert.equal(await page.locator('.wordmark img').evaluateAll(nodes => nodes.length === 2 && nodes.every(node => node.complete && node.naturalWidth > 0)), true);
      assert.equal(await page.locator('html').evaluate(node => node.classList.contains('motion-enabled')), true, `${label}: compact-screen motion must be enabled`);
      const normalLayout = await layout(page, label);
      const normalSweep = await sweep(page, label);
      await positionStage(page, Math.max(68, (viewport.height - 440) / 2));
      await page.screenshot({ path: path.join(output, `mobile-${label}.png`) });
      const controls = await motionControls(page);
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await settle(page);
      const enlargedLayout = await layout(page, `${label} at 200% root font size`);
      const enlargedSweep = await sweep(page, `${label} at 200% root font size`);
      await positionStage(page, 100);
      await page.screenshot({ path: path.join(output, `mobile-${label}-text-200.png`) });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await settle(page);
      assert.equal(await page.locator('html').evaluate(node => node.classList.contains('motion-enabled')), false);
      assert.equal(await page.locator('#motion-toggle').isVisible(), false);
      assert.equal(await page.locator('.rig').getAttribute('style'), null, 'Reduced Motion must remove stale animated inline transforms');
      const reducedSweep = await sweep(page, `${label} with Reduce Motion`, false);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await settle(page);
      assert.equal(await page.locator('#motion-toggle').isVisible(), true, 'Turning off Reduce Motion must restore the control');
      assert.deepEqual(errors, [], `${label}: browser console and page errors`);
      results.checks.push({ viewport, normalLayout, normalSweep, controls, enlargedLayout, enlargedSweep, reducedSweep, errors });
      await context.close();
    }

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await layout(page, 'Desktop', false);
    assert.equal(await page.locator('.visual').evaluate(node => getComputedStyle(node).position), 'sticky');
    await page.locator('[data-stage="1"]').click();
    await settle(page);
    const desktopPose = await pose(page);
    await page.locator('[data-stage="2"]').click();
    await settle(page);
    assert.notDeepEqual(await pose(page), desktopPose, 'Desktop chapter navigation must still change the rig pose');
    await page.getByRole('button', { name: 'Pause motion', exact: true }).click();
    await page.setViewportSize({ width: 402, height: 874 });
    await settle(page);
    await layout(page, 'Desktop resized to mobile');
    const pausedResizeSweep = await sweep(page, 'Paused desktop resized to mobile', false);
    await page.getByRole('button', { name: 'Resume motion', exact: true }).click();
    await sweep(page, 'Desktop resized to mobile');
    await page.setViewportSize({ width: 1280, height: 800 });
    await settle(page);
    assert.equal(await page.locator('.visual').evaluate(node => getComputedStyle(node).position), 'sticky');
    await page.setViewportSize({ width: 1440, height: 600 });
    await settle(page);
    await layout(page, 'Wide short viewport');
    const shortSweep = await sweep(page, 'Wide short viewport');
    await page.screenshot({ path: path.join(output, 'short-desktop-1440x600.png') });
    results.checks.push({ desktopNavigation: 'passed', breakpointTransitions: 'Paused desktop to compact, resume, back to desktop, then wide short viewport', pausedResizeSweep, shortSweep });
    await context.close();

    const noJsContext = await browser.newContext({ viewport: { width: 402, height: 874 }, javaScriptEnabled: false, isMobile: true, hasTouch: true });
    const noJsPage = await noJsContext.newPage();
    await noJsPage.goto(url, { waitUntil: 'networkidle' });
    assert.equal(await noJsPage.locator('#motion-toggle').isVisible(), false);
    assert.equal(await noJsPage.getByRole('link', { name: 'Open the evidence package' }).count(), 1);
    await layout(noJsPage, 'Mobile without JavaScript');
    await noJsPage.locator('.visual').screenshot({ path: path.join(output, 'mobile-no-javascript.png') });
    results.checks.push({ noJavaScript: 'Evidence link, static diagram and separate legend remain available; nonfunctional motion control stays hidden.' });
    await noJsContext.close();
    results.status = 'passed';
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  results.status = 'failed';
  results.error = error.stack;
  process.exitCode = 1;
}).finally(() => {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'verification.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
});
