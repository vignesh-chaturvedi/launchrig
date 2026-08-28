import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initProject } from "../src/commands/init.js";
import { loadConfig, validateConfigPaths } from "../src/config/load.js";
import { ConfigError, validateConfig } from "../src/config/schema.js";
import { validateMaestroFlowSafety, validatePilotFlowReadiness } from "../src/security/flow.js";

function validRawConfig(): Record<string, unknown> {
  return {
    version: 1,
    project: { name: "Fixture", packageName: "dev.launchrig.fixture", install: false },
    target: { network: "devnet" },
    device: { requirePhysical: true, minimumApiLevel: 26 },
    wallet: { mode: "mock-mwa", packageName: "com.solana.mwallet", install: false },
    scenarios: [],
    artifacts: { directory: "./.launchrig/results", screenshots: "failure", retention: 5 },
    privacy: { includeLogcat: false, logcatLines: 200, redactPatterns: [] },
    tooling: {},
  };
}

test("strict config accepts the Phase 1 devnet contract", () => {
  const config = validateConfig(validRawConfig());
  assert.equal(config.target.network, "devnet");
  assert.equal(config.device.requirePhysical, true);
  assert.equal(config.wallet.packageName, "com.solana.mwallet");
});

test("strict config accepts versioned lifecycle scenario kinds", () => {
  for (const kind of ["mwa-stale-authorization", "mwa-process-death"] as const) {
    const raw = validRawConfig();
    raw.scenarios = [
      {
        id: kind,
        kind,
        name: "Lifecycle recovery",
        flow: "./flow.yaml",
        required: true,
        timeoutMs: 120000,
      },
    ];
    assert.equal(validateConfig(raw).scenarios[0]?.kind, kind);
  }
});

test("config rejects mainnet and unknown keys", () => {
  const raw = validRawConfig();
  raw.target = { network: "mainnet-beta" };
  raw.unexpected = true;
  assert.throws(
    () => validateConfig(raw),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.issues.some((issue) => issue.includes("refuses mainnet")) &&
      error.issues.some((issue) => issue.includes("unexpected")),
  );
});

test("official reference fakedapp is accepted only when labeled testnet", () => {
  const raw = validRawConfig();
  raw.project = {
    name: "Official MWA fixture",
    packageName: "com.solana.mobilewalletadapter.fakedapp",
    install: false,
  };
  raw.target = { network: "testnet" };
  assert.equal(validateConfig(raw).target.network, "testnet");

  raw.target = { network: "devnet" };
  assert.throws(
    () => validateConfig(raw),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.issues.some((issue) => issue.includes("hard-coded to testnet")),
  );
});

test("init creates a valid config and never overwrites silently", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-init-"));
  try {
    await initProject({
      cwd: directory,
      force: false,
      projectName: "Pocket Demo",
      packageName: "dev.launchrig.demo",
    });
    const config = await loadConfig(path.join(directory, "launchrig.yml"));
    assert.equal(config.project.name, "Pocket Demo");
    assert.equal(config.project.packageName, "dev.launchrig.demo");
    assert.deepEqual(await validateConfigPaths(config), []);
    await assert.rejects(() => initProject({ cwd: directory, force: false }));
    const gitignore = await readFile(path.join(directory, ".gitignore"), "utf8");
    assert.match(gitignore, /^\.launchrig\/$/m);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("flow paths resolve relative to launchrig.yml", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-config-"));
  try {
    await writeFile(path.join(directory, "flow.yaml"), "appId: dev.launchrig.fixture\n---\n- launchApp\n", "utf8");
    const raw = validRawConfig();
    raw.scenarios = [{ id: "authorize", kind: "mwa-authorize", name: "Authorize", flow: "./flow.yaml" }];
    const { stringify } = await import("yaml");
    await writeFile(path.join(directory, "launchrig.yml"), stringify(raw), "utf8");
    const config = await loadConfig(path.join(directory, "launchrig.yml"));
    assert.equal(config.scenarios[0]?.resolvedFlow, path.join(directory, "flow.yaml"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real-wallet configs require screenshots to be disabled", () => {
  const raw = validRawConfig();
  raw.wallet = { mode: "real", packageName: "com.publisher.wallet", install: false };
  assert.throws(
    () => validateConfig(raw),
    (error: unknown) =>
      error instanceof ConfigError && error.issues.some((issue) => issue.includes("screenshots must be never")),
  );

  raw.artifacts = { directory: "./.launchrig/results", screenshots: "never", retention: 5 };
  assert.equal(validateConfig(raw).wallet.mode, "real");

  raw.scenarios = [{ id: "authorize", kind: "mwa-authorize", name: "Authorize", flow: "./flow.yaml" }];
  assert.throws(
    () => validateConfig(raw),
    (error: unknown) =>
      error instanceof ConfigError && error.issues.some((issue) => issue.includes("automated wallet scenarios are disabled")),
  );

  raw.scenarios = [];
  raw.privacy = { includeLogcat: true, logcatLines: 200, redactPatterns: [] };
  assert.throws(
    () => validateConfig(raw),
    (error: unknown) =>
      error instanceof ConfigError && error.issues.some((issue) => issue.includes("includeLogcat must be false")),
  );
});

test("flow safety permits policy-limited commands and inline subflows", () => {
  const source = [
    "appId: com.publisher.app",
    "---",
    "- launchApp:",
    "    clearState: false",
    "- tapOn: Connect",
    "- runFlow:",
    "    when:",
    "      visible: Ready",
    "    commands:",
    "      - assertVisible: Ready",
    "",
  ].join("\n");
  assert.deepEqual(validateMaestroFlowSafety(source, "com.publisher.app"), []);
});

test("pilot flow readiness rejects reserved selectors without scanning comments or input text", () => {
  const safeSource = [
    "# TODO: this comment is publisher guidance",
    "appId: com.publisher.app",
    "---",
    "- inputText: \"TODO: literal test input\"",
    "- assertVisible:",
    "    id: publisher-ready",
    "",
  ].join("\n");
  assert.deepEqual(validatePilotFlowReadiness(safeSource), []);

  const reservedSelectors = [
    "- assertVisible: \"TODO: ready-selector\"",
    "- scrollUntilVisible:\n    element:\n      id: \"TODO: result-selector\"",
    "- extendedWaitUntil:\n    notVisible: \"TODO: loading-selector\"",
    [
      "- runFlow:",
      "    when:",
      "      visible: \"TODO: condition-selector\"",
      "    commands:",
      "      - tapOn: publisher-ready",
    ].join("\n"),
    [
      "- repeat:",
      "    times: 2",
      "    commands:",
      "      - retry:",
      "          maxRetries: 1",
      "          commands:",
      "            - tapOn:\n                id: \"TODO: nested-selector\"",
    ].join("\n"),
    [
      "- repeat:",
      "    while:",
      "      visible: \"TODO: repeat-condition\"",
      "    commands:",
      "      - tapOn: publisher-ready",
    ].join("\n"),
  ];
  for (const command of reservedSelectors) {
    const issues = validatePilotFlowReadiness("appId: com.publisher.app\n---\n" + command + "\n");
    assert.ok(issues.some((issue) => issue.includes("reserved TODO: selector")));
  }
  assert.ok(
    validatePilotFlowReadiness("appId: com.publisher.app\n---\n[]\n").some((issue) =>
      issue.includes("non-empty array"),
    ),
  );
});

test("path validation requires configured artifacts and regular publisher flow files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-safe-paths-"));
  try {
    const outsideFlow = path.join(directory, "outside.yaml");
    const linkedFlow = path.join(directory, "linked.yaml");
    await writeFile(outsideFlow, "appId: com.publisher.app\n---\n- launchApp\n", "utf8");
    await symlink(outsideFlow, linkedFlow);
    const raw = validRawConfig();
    raw.project = {
      name: "Publisher",
      packageName: "com.publisher.app",
      apk: "./missing-app.apk",
      install: false,
    };
    raw.wallet = {
      mode: "mock-mwa",
      packageName: "com.solana.mwallet",
      apk: "./missing-wallet.apk",
      install: false,
    };
    raw.scenarios = [
      { id: "authorize", kind: "mwa-authorize", name: "Authorize", flow: "./linked.yaml" },
    ];
    const { stringify } = await import("yaml");
    const configPath = path.join(directory, "launchrig.yml");
    await writeFile(configPath, stringify(raw), "utf8");
    const issues = await validateConfigPaths(await loadConfig(configPath));
    assert.ok(issues.some((issue) => issue.includes("APK is missing")));
    assert.ok(issues.some((issue) => issue.includes("Wallet fixture APK is missing")));
    assert.ok(issues.some((issue) => issue.includes("flow cannot be read safely")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("flow safety rejects state clearing, scripts, external subflows, aliases, and duplicate keys", async (context) => {
  const unsafeFlows = [
    ["string clearState", "appId: com.publisher.app\n---\n- clearState\n"],
    ["object clearState", "appId: com.publisher.app\n---\n- clearState: true\n"],
    ["clearKeychain", "appId: com.publisher.app\n---\n- clearKeychain\n"],
    ["evalScript", "appId: com.publisher.app\n---\n- evalScript: output.value\n"],
    ["runScript", "appId: com.publisher.app\n---\n- runScript: ./script.js\n"],
    ["string runFlow", "appId: com.publisher.app\n---\n- runFlow: ./other.yaml\n"],
    ["file runFlow", "appId: com.publisher.app\n---\n- runFlow:\n    file: ./other.yaml\n    commands: []\n"],
    ["YAML alias", "commands: &shared\n  - assertVisible: Ready\n---\n- runFlow:\n    commands: *shared\n"],
    ["duplicate key", "appId: com.publisher.app\nappId: com.publisher.other\n---\n- launchApp\n"],
  ] as const;
  for (const [name, source] of unsafeFlows) {
    await context.test(name, () => assert.ok(validateMaestroFlowSafety(source, "com.publisher.app").length > 0));
  }
});

test("flow safety rejects capture, AI, permission, network, interpolation, and app targeting commands", async (context) => {
  const unsafeCommands = [
    "takeScreenshot: private-screen",
    "startRecording: private-video",
    "assertScreenshot: golden-screen",
    "assertWithAI: find account details",
    "extractTextWithAI: read wallet address",
    "setPermissions:\n    camera: allow",
    "setClipboard: secret",
    "toggleAirplaneMode",
    'openLink: "https://example.invalid/${API_TOKEN}"',
    "launchApp: com.other.app",
    "stopApp: com.other.app",
  ] as const;
  for (const command of unsafeCommands) {
    await context.test(command.split(":")[0] ?? command, () => {
      const source = "appId: com.publisher.app\n---\n- " + command + "\n";
      assert.ok(validateMaestroFlowSafety(source, "com.publisher.app").length > 0);
    });
  }
  assert.ok(
    validateMaestroFlowSafety("appId: com.other.app\n---\n- launchApp\n", "com.publisher.app").length > 0,
  );
  assert.ok(
    validateMaestroFlowSafety("appId: com.publisher.app\n---\n- pressKey: HOME\n", "com.publisher.app").length > 0,
  );
  assert.ok(
    validateMaestroFlowSafety(
      "appId: com.publisher.app\n---\n- launchApp:\n    arguments:\n      private: value\n",
      "com.publisher.app",
    ).length > 0,
  );
  assert.ok(validateMaestroFlowSafety("appId: com.publisher.app\n", "com.publisher.app").length > 0);
  assert.ok(
    validateMaestroFlowSafety(
      'appId: com.publisher.app\n---\n- openLink: "publisher://app/ready"\n',
      "com.publisher.app",
    ).some((issue) => issue.includes("reserved for the controlled")),
  );
  assert.deepEqual(
    validateMaestroFlowSafety(
      'appId: dev.launchrig.fixture\n---\n- openLink:\n    link: "launchrig://fixture/rejection?variant=broken"\n',
      "dev.launchrig.fixture",
    ),
    [],
  );
});

test("published schemas stay synchronized with lifecycle and privacy rules", async () => {
  const configSchema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas", "launchrig.schema.json"), "utf8"),
  ) as Record<string, any>;
  const lifecycleKinds = configSchema.properties.scenarios.items.properties.kind.enum as string[];
  assert.ok(lifecycleKinds.includes("mwa-stale-authorization"));
  assert.ok(lifecycleKinds.includes("mwa-process-death"));
  assert.equal(configSchema.properties.scenarios.maxItems, 50);
  assert.equal(configSchema.allOf[2].then.properties.artifacts.properties.screenshots.const, "never");
  assert.equal(configSchema.allOf[2].then.properties.privacy.properties.includeLogcat.const, false);
  assert.equal(configSchema.allOf[2].then.properties.scenarios.maxItems, 0);

  const pilotSchema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas", "launchrig-pilot-evidence.schema.json"), "utf8"),
  ) as Record<string, any>;
  const pilotV1Schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas", "launchrig-pilot-evidence-v1.schema.json"), "utf8"),
  ) as Record<string, any>;
  const pilotV2Schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas", "launchrig-pilot-evidence-v2.schema.json"), "utf8"),
  ) as Record<string, any>;
  assert.equal(pilotSchema.properties.schemaVersion.const, 1);
  assert.equal(pilotSchema.properties.claimStatus.const, "self-recorded-unattested");
  assert.equal(pilotSchema.properties.claims.properties.seekerHardware.const, "not-established");
  assert.equal(pilotV1Schema.properties.schemaVersion.const, 1);
  assert.equal(pilotV2Schema.properties.schemaVersion.const, 2);
  assert.equal(pilotV2Schema.properties.claimStatus.const, "self-recorded-unattested");
  assert.equal(pilotV2Schema.$defs.technicalPilot.properties.profile.const, "external-mwa-pilot-v1");
  assert.equal(pilotV2Schema.$defs.technicalPilot.properties.requiredTrailingMwaPasses.const, 3);
  assert.ok(pilotV2Schema.$defs.run.required.includes("elapsedSinceStartMs"));
  assert.ok(pilotV2Schema.$defs.run.required.includes("executionFingerprintSha256"));
  for (const claim of Object.values(pilotV2Schema.$defs.claims.properties) as Array<Record<string, unknown>>) {
    assert.equal(claim.const, "not-established");
  }

  const privateRegisterSchema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas", "launchrig-private-cohort-register.schema.json"), "utf8"),
  ) as Record<string, any>;
  const privateAuditSchema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas", "launchrig-private-cohort-audit.schema.json"), "utf8"),
  ) as Record<string, any>;
  assert.equal(privateRegisterSchema.additionalProperties, false);
  assert.equal(privateRegisterSchema.properties.profile.const, "phase-2c-publisher-governance-v1");
  assert.equal(privateRegisterSchema.properties.privacyProfile.const, "opaque-refs-digests-dates-v1");
  assert.equal(privateRegisterSchema.properties.candidates.maxItems, 25);
  assert.equal(privateRegisterSchema.$defs.candidate.additionalProperties, false);
  assert.equal(privateRegisterSchema.$defs.evidenceBinding.additionalProperties, false);
  assert.deepEqual(privateRegisterSchema.$defs.evidenceBinding.properties.schemaVersion.enum, [1, 2]);
  assert.equal(privateAuditSchema.additionalProperties, false);
  assert.equal(privateAuditSchema.properties.profile.const, "phase-2c-publisher-governance-v1");
  assert.equal(privateAuditSchema.properties.externalGrantGate.properties.status.const, "not-established");
  assert.equal(privateAuditSchema.properties.grantReady.const, false);
  assert.equal(privateAuditSchema.properties.entries.maxItems, 25);
});

test("config caps scenario count at the pilot evidence limit", () => {
  const raw = validRawConfig();
  raw.scenarios = Array.from({ length: 51 }, (_, index) => ({
    id: "scenario-" + index,
    kind: "custom",
    name: "Scenario " + index,
    flow: "./flow-" + index + ".yaml",
  }));
  assert.throws(
    () => validateConfig(raw),
    (error: unknown) => error instanceof ConfigError && error.issues.some((issue) => issue.includes("at most 50")),
  );
});

test("wallet modes are bound to their package identities and MWA flows require a wallet", () => {
  const mismatched = validRawConfig();
  mismatched.wallet = {
    mode: "mock-mwa",
    packageName: "com.solana.mobilewalletadapter.fakewallet",
    install: false,
  };
  assert.throws(
    () => validateConfig(mismatched),
    (error: unknown) => error instanceof ConfigError && error.issues.some((issue) => issue.includes("mock-mwa requires")),
  );

  const missing = validRawConfig();
  missing.wallet = { mode: "real", install: false };
  missing.artifacts = { directory: "./.launchrig/results", screenshots: "never", retention: 5 };
  missing.scenarios = [
    { id: "authorize", kind: "mwa-authorize", name: "Authorize", flow: "./authorize.yaml" },
  ];
  assert.throws(
    () => validateConfig(missing),
    (error: unknown) =>
      error instanceof ConfigError && error.issues.some((issue) => issue.includes("required when an MWA scenario")),
  );
});
