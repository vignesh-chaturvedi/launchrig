import type { CheckResult, LaunchRigReport } from "../types.js";

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeXml(value: unknown): string {
  return escapeHtml(value);
}

function checkCard(check: CheckResult): string {
  const reproduction = check.reproduction?.length
    ? "<ol>" + check.reproduction.map((step) => "<li>" + escapeHtml(step) + "</li>").join("") + "</ol>"
    : "";
  const details = check.details ? "<pre>" + escapeHtml(check.details) + "</pre>" : "";
  const artifacts = check.artifacts?.length
    ? '<p class="artifact-label">Evidence</p><ul class="artifacts">' +
      check.artifacts.map((artifact) => "<li>" + escapeHtml(artifact) + "</li>").join("") +
      "</ul>"
    : "";
  return [
    '<article class="check ' + escapeHtml(check.status) + '">',
    '<div class="check-head"><span class="status">' + escapeHtml(check.status) + "</span>",
    "<h3>" + escapeHtml(check.name) + "</h3>",
    '<span class="duration">' + escapeHtml(check.durationMs) + " ms</span></div>",
    "<p>" + escapeHtml(check.summary) + "</p>",
    details,
    artifacts,
    reproduction,
    "</article>",
  ].join("");
}

export function renderHtml(report: LaunchRigReport): string {
  const passed = report.checks.filter((check) => check.status === "pass").length;
  const failed = report.checks.filter((check) => check.status === "fail").length;
  const warned = report.checks.filter((check) => check.status === "warn").length;
  const device = report.device;
  const deviceSummary = device
    ? escapeHtml(device.manufacturer + " " + device.model + " · Android " + device.androidVersion + " / API " + device.apiLevel)
    : "No device metadata captured";
  const appSummary =
    escapeHtml(report.app.packageName) +
    (report.app.versionName ? " · v" + escapeHtml(report.app.versionName) : "") +
    (report.app.versionCode ? " (" + escapeHtml(report.app.versionCode) + ")" : "");
  const walletSummary = report.wallet
    ? escapeHtml(report.wallet.packageName) +
      (report.wallet.versionName ? " · v" + escapeHtml(report.wallet.versionName) : "") +
      (report.wallet.versionCode ? " (" + escapeHtml(report.wallet.versionCode) + ")" : "")
    : "No wallet metadata captured";
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">',
    "<title>LaunchRig report · " + escapeHtml(report.project) + "</title>",
    "<style>",
    ":root{color-scheme:dark;--bg:#080a0f;--panel:#11151d;--line:#263043;--text:#eef2ff;--muted:#97a2b7;--violet:#9d7bff;--green:#55e6a5;--red:#ff6b7a;--amber:#ffd166}",
    "*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#251747 0,transparent 32rem),var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}",
    ".shell{width:min(980px,calc(100% - 32px));margin:0 auto;padding:56px 0 80px}.eyebrow{color:var(--violet);font:700 12px/1.2 ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase}",
    "h1{font-size:clamp(38px,7vw,72px);line-height:.95;margin:16px 0 20px;letter-spacing:-.05em}.lede{max-width:680px;color:var(--muted);font-size:18px}",
    ".badge{display:inline-flex;border:1px solid var(--line);border-radius:99px;padding:8px 13px;margin-top:12px;background:#0b0e14}.passed .badge{color:var(--green)}.failed .badge,.setup-error .badge{color:var(--red)}",
    ".metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:34px 0}.metric,.device,.check{border:1px solid var(--line);background:rgba(17,21,29,.9);border-radius:16px;padding:18px}.metric strong{display:block;font-size:30px}.metric span,.device p,.duration{color:var(--muted)}",
    ".checks{display:grid;gap:12px}.check{border-left-width:4px}.check.pass{border-left-color:var(--green)}.check.fail{border-left-color:var(--red)}.check.warn{border-left-color:var(--amber)}.check.skip{border-left-color:var(--muted)}",
    ".check-head{display:flex;align-items:center;gap:12px}.check h3{margin:0;flex:1}.status{font:700 11px ui-monospace,monospace;text-transform:uppercase}.pass .status{color:var(--green)}.fail .status{color:var(--red)}.warn .status{color:var(--amber)}",
    "pre{overflow:auto;background:#090c12;border-radius:10px;padding:12px;color:#cad3e6;white-space:pre-wrap}.artifact-label{margin-bottom:4px;font-weight:700}.artifacts{margin-top:0;color:var(--muted);font-family:ui-monospace,monospace;font-size:13px}footer{color:var(--muted);margin-top:28px;font-size:13px}@media(max-width:640px){.metrics{grid-template-columns:1fr}.check-head{align-items:flex-start;flex-wrap:wrap}}",
    "</style></head><body>",
    '<main class="shell ' + escapeHtml(report.outcome) + '">',
    '<p class="eyebrow">LaunchRig · physical-device evidence</p>',
    "<h1>" + escapeHtml(report.readiness) + "</h1>",
    '<p class="lede">' + escapeHtml(report.project) + " · " + escapeHtml(report.packageName) + " · " + escapeHtml(report.network) + "</p>",
    '<div class="badge">Outcome: ' + escapeHtml(report.outcome) + "</div>",
    '<section class="metrics"><div class="metric"><strong>' + passed + "</strong><span>passed</span></div>",
    '<div class="metric"><strong>' + failed + "</strong><span>failed</span></div>",
    '<div class="metric"><strong>' + warned + "</strong><span>warnings</span></div></section>",
    '<section class="device"><p class="eyebrow">Device</p><p>' + deviceSummary + "</p></section>",
    '<section class="device"><p class="eyebrow">Applications</p><p>App: ' + appSummary + "</p><p>Wallet: " + walletSummary + "</p></section>",
    '<section><p class="eyebrow">Checks</p><div class="checks">' + report.checks.map(checkCard).join("") + "</div></section>",
    "<footer>Run " + escapeHtml(report.runId) + " · LaunchRig " + escapeHtml(report.launchRigVersion) + " · This is not a Seeker certification.</footer>",
    "</main></body></html>",
  ].join("");
}

export function renderJunit(report: LaunchRigReport): string {
  const failures = report.checks.filter((check) => check.status === "fail").length;
  const skipped = report.checks.filter((check) => check.status === "skip").length;
  const cases = report.checks
    .map((check) => {
      const seconds = (check.durationMs / 1000).toFixed(3);
      const body =
        check.status === "fail"
          ? '<failure message="' + escapeXml(check.summary) + '">' + escapeXml(check.details ?? check.summary) + "</failure>"
          : check.status === "skip"
            ? "<skipped/>"
            : check.status === "warn"
              ? "<system-out>" + escapeXml("WARNING: " + check.summary) + "</system-out>"
              : "";
      return (
        '<testcase classname="launchrig" name="' +
        escapeXml(check.name) +
        '" time="' +
        seconds +
        '">' +
        body +
        "</testcase>"
      );
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<testsuite name="LaunchRig" tests="' +
    report.checks.length +
    '" failures="' +
    failures +
    '" skipped="' +
    skipped +
    '" time="' +
    (report.durationMs / 1000).toFixed(3) +
    '">' +
    cases +
    "</testsuite>\n"
  );
}
