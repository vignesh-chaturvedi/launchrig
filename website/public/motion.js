(() => {
  const root = document.documentElement;
  const sequence = document.querySelector('.sequence');
  const visual = document.querySelector('.visual');
  const stage = document.querySelector('.stage');
  const rig = document.querySelector('.rig');
  const toggle = document.querySelector('#motion-toggle');
  const anchors = [...document.querySelectorAll('[data-stage]')];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const desktop = matchMedia('(min-width: 1001px) and (min-height: 701px)');
  const pointer = matchMedia('(hover: hover) and (pointer: fine)');
  let paused = false;
  let visible = true;
  let frame = 0;
  let tiltX = 0;
  let tiltY = 0;
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const mix = (a, b, n) => a + (b - a) * n;
  const poses = [
    { rx: 48, rz: -28, ax: 0, ay: -45, az: 120, wx: 0, wy: -2, wz: 25, ex: 0, ey: 48, ez: -65 },
    { rx: 38, rz: -18, ax: -22, ay: -78, az: 130, wx: 18, wy: 0, wz: 20, ex: 10, ey: 70, ez: -65 },
    { rx: 12, rz: -6, ax: 20, ay: -115, az: -50, wx: -20, wy: -55, wz: -5, ex: 0, ey: 65, ez: 135 }
  ];
  // Compact poses keep the full recovery sequence inside the mobile canvas.
  const compactPoses = [
    { rx: 40, rz: -20, ax: 0, ay: -48, az: 95, wx: 0, wy: 0, wz: 15, ex: 0, ey: 45, ez: -55 },
    { rx: 30, rz: -12, ax: -12, ay: -65, az: 100, wx: 12, wy: 0, wz: 15, ex: 0, ey: 50, ez: -50 },
    { rx: 16, rz: -4, ax: 12, ay: -75, az: -45, wx: -12, wy: -30, wz: 0, ex: 0, ey: 55, ez: 80 }
  ];
  function render() {
    frame = 0;
    if (document.hidden) return;
    const chapterIndex = ['connect', 'interrupt', 'inspect'].reduce((active, id, index) =>
      document.getElementById(id).getBoundingClientRect().top <= innerHeight * .45 ? index : active, 0);
    anchors.forEach((anchor, i) => {
      if (i === chapterIndex) anchor.setAttribute('aria-current', 'step');
      else anchor.removeAttribute('aria-current');
    });
    if (!visible || paused || reduced.matches) return;
    const bounds = (desktop.matches ? sequence : stage).getBoundingClientRect();
    // Mobile has no sticky column. Complete the movement while its canvas is in view.
    const progress = desktop.matches
      ? clamp((80 - bounds.top) / Math.max(1, bounds.height - innerHeight + 80), 0, 1) * 2
      : clamp((innerHeight * .85 - bounds.top) / Math.max(1, innerHeight * .65), 0, 1) * 2;
    const activePoses = desktop.matches ? poses : compactPoses;
    const index = Math.min(1, Math.floor(progress));
    const t = progress - index;
    const smooth = t * t * (3 - 2 * t);
    for (const key of Object.keys(activePoses[0])) {
      let value = mix(activePoses[index][key], activePoses[index + 1][key], smooth);
      if (key === 'rx' && desktop.matches) value += tiltY;
      const unit = key.startsWith('r') ? 'deg' : 'px';
      rig.style.setProperty(`--${key}`, `${value.toFixed(2)}${unit}`);
    }
    rig.style.setProperty('--ry', `${(desktop.matches ? tiltX : 0).toFixed(2)}deg`);
  }
  function schedule() {
    if (!frame && !document.hidden) frame = requestAnimationFrame(render);
  }
  function configure() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const enabled = !reduced.matches;
    tiltX = 0;
    tiltY = 0;
    // Breakpoint changes must not retain a paused desktop pose on a narrow canvas.
    rig.removeAttribute('style');
    root.classList.toggle('motion-enabled', enabled);
    toggle.hidden = !enabled;
    if (!enabled) anchors.forEach(a => a.removeAttribute('aria-current'));
    schedule();
  }
  toggle.addEventListener('click', () => {
    paused = !paused;
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.textContent = paused ? 'Resume motion' : 'Pause motion';
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    schedule();
  });
  visual.addEventListener('pointermove', event => {
    if (!pointer.matches || paused || reduced.matches || !desktop.matches) return;
    const b = visual.getBoundingClientRect();
    tiltX = clamp((event.clientX - b.left) / b.width - .5, -.5, .5) * 5;
    tiltY = clamp((event.clientY - b.top) / b.height - .5, -.5, .5) * -3;
    schedule();
  });
  visual.addEventListener('pointerleave', () => { tiltX = 0; tiltY = 0; schedule(); });
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && frame) { cancelAnimationFrame(frame); frame = 0; }
    else schedule();
  });
  if ('IntersectionObserver' in window) new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (!visible && frame) { cancelAnimationFrame(frame); frame = 0; }
    else schedule();
  }).observe(visual);
  reduced.addEventListener('change', configure);
  desktop.addEventListener('change', configure);
  configure();
})();
