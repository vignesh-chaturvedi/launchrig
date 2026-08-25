import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReport } from "../src/report/model.js";
import { escapeHtml, escapeXml } from "../src/report/render.js";
import { writeReportArtifacts } from "../src/report/write.js";
import { sanitizeMaestroJunit } from "../src/security/maestro.js";
import { redactText } from "../src/security/redact.js";

test("redactor removes local paths, headers, tokens, key material, and base58 identifiers", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmnop";
  const base58 = "4Nd1mYbN9VMyqV8MpXLySXF7pVszqAuiD4kYXKZ4tJto";
  const source =
    "/Users/alice/work/launchrig.jar Authorization: Bearer abc.def auth_token=secret123 jwt=" +
    jwt +
    " wallet=" +
    base58;
  const result = redactText(source);
  assert.ok(result.count >= 3);
  assert.doesNotMatch(result.value, /alice|launchrig\.jar|secret123|4Nd1mY|eyJhbGci/);
  assert.match(result.value, /\[REDACTED:LOCAL_PATH\]/);
  assert.match(result.value, /Authorization: Bearer \[REDACTED\]/);
});

test("HTML and XML escape hostile dynamic content", () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(escapeXml("a&b<c"), "a&amp;b&lt;c");
});

test("Maestro JUnit masks raw device identifiers and tokens", () => {
  const source =
    '<testsuite device="PHONE-SERIAL-123456"><system-out>auth_token=fixture-secret</system-out></testsuite>';
  const sanitized = sanitizeMaestroJunit(source, "PHONE-SERIAL-123456");
  assert.doesNotMatch(sanitized, /PHONE-SERIAL-123456|fixture-secret/);
  assert.match(sanitized, /device="\*\*\*3456"/);
});

test("report writer emits sanitized JSON, HTML, and JUnit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-report-"));
  try {
    const startedAt = new Date("2026-08-25T00:00:00.000Z");
    const completedAt = new Date("2026-08-25T00:00:01.000Z");
    const report = createReport({
      runId: "fixture-run",
      project: "<script>fixture</script>",
      packageName: "dev.launchrig.fixture",
      network: "devnet",
      startedAt,
      completedAt,
      checks: [
        {
          id: "scenario.authorize",
          name: "Authorize & return",
          status: "fail",
          required: true,
          durationMs: 1000,
          summary: "auth_token=topsecret",
        },
      ],
      device: {
        serial: "SERIAL-123456",
        manufacturer: "Acme",
        model: "Phone",
        androidVersion: "16",
        apiLevel: 36,
        abi: "arm64-v8a",
        securityPatch: "2026-08-01",
        isEmulator: false,
      },
    });
    const files = await writeReportArtifacts(report, directory);
    const [json, html, junit] = await Promise.all([
      readFile(files.json, "utf8"),
      readFile(files.html, "utf8"),
      readFile(files.junit, "utf8"),
    ]);
    assert.doesNotMatch(json, /topsecret|SERIAL-123456/);
    assert.doesNotMatch(html, /<script>fixture<\/script>/);
    assert.match(html, /&lt;script&gt;fixture&lt;\/script&gt;/);
    assert.match(junit, /Authorize &amp; return/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
