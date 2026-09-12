(() => {
  const root = document.documentElement;
  const sequence = document.querySelector('.sequence');
  const visual = document.querySelector('.visual');
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
  function render() {
    frame = 0;
    if (document.hidden) return;
    const chapterIndex = ['connect', 'interrupt', 'inspect'].reduce((active, id, index) =>
      document.getElementById(id).getBoundingClientRect().top <= innerHeight * .45 ? index : active, 0);
    anchors.forEach((anchor, i) => {
      if (i === chapterIndex) anchor.setAttribute('aria-current', 'step');
      else anchor.removeAttribute('aria-current');
    });
    if (!visible || paused || reduced.matches || !desktop.matches) return;
    const bounds = sequence.getBoundingClientRect();
    const progress = clamp((80 - bounds.top) / Math.max(1, bounds.height - innerHeight + 80), 0, 1) * 2;
    const index = Math.min(1, Math.floor(progress));
    const t = progress - index;
    const smooth = t * t * (3 - 2 * t);
    for (const key of Object.keys(poses[0])) {
      let value = mix(poses[index][key], poses[index + 1][key], smooth);
      if (key === 'rx') value += tiltY;
      const unit = key.startsWith('r') ? 'deg' : 'px';
      rig.style.setProperty(`--${key}`, `${value.toFixed(2)}${unit}`);
    }
    rig.style.setProperty('--ry', `${tiltX.toFixed(2)}deg`);
  }
  function schedule() {
    if (!frame && !document.hidden) frame = requestAnimationFrame(render);
  }
  function configure() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const enabled = !reduced.matches && desktop.matches;
    root.classList.toggle('motion-enabled', enabled);
    toggle.hidden = !enabled;
    if (!enabled) { rig.removeAttribute('style'); anchors.forEach(a => a.removeAttribute('aria-current')); }
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
