import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initProject } from "../src/commands/init.js";
import { loadConfig, validateConfigPaths } from "../src/config/load.js";
import { ConfigError, validateConfig } from "../src/config/schema.js";
import { validateMaestroFlowSafety } from "../src/security/flow.js";

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
  assert.equal(pilotSchema.properties.claimStatus.const, "self-recorded-unattested");
  assert.equal(pilotSchema.properties.claims.properties.seekerHardware.const, "not-established");
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
