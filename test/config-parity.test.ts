import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";
import {
  ANDROID_APPLICATION_ID_PATTERN,
  ARTIFACT_KEYS,
  CONFIG_NETWORKS,
  CONFIG_ROOT_KEYS,
  CONFIG_V1_CONFORMANCE_PATH,
  CONFIG_V1_DEFAULTS,
  CONFIG_V1_LIMITS,
  CONFIG_V1_RUNTIME_EXTENSIONS,
  CONFIG_V1_SCHEMA_ID,
  CONFIG_V1_VERSION,
  DEVICE_KEYS,
  INSTALLABLE_TEST_WALLET_PACKAGES,
  INSTALL_POLICIES,
  MOCK_MWA_PACKAGE,
  MWA_SCENARIO_KINDS,
  PRIVACY_KEYS,
  PROJECT_KEYS,
  REFERENCE_FAKEDAPP_PACKAGE,
  REFERENCE_FAKEWALLET_PACKAGE,
  SCENARIO_ID_PATTERN,
  SCENARIO_KEYS,
  SCENARIO_KINDS,
  SCREENSHOT_MODES,
  TARGET_KEYS,
  TOOLING_KEYS,
  WALLET_KEYS,
  WALLET_MODES,
} from "../src/config/contract.js";
import { ConfigError, validateConfig } from "../src/config/schema.js";
import { STARTER_CONFIG } from "../src/config/starter.js";

type JsonRecord = Record<string, unknown>;

interface ConformanceCase {
  id: string;
  classification: "parity" | "runtime-extension";
  set: Record<string, unknown>;
  remove: string[];
  runtimeValid: boolean;
  schemaValid: boolean;
}

interface ConformanceCorpus {
  schemaVersion: number;
  kind: string;
  configVersion: number;
  status: string;
  schemaPath: string;
  parityCaseCount: number;
  runtimeExtensionCaseCount: number;
  grantMilestoneComplete: boolean;
  base: JsonRecord;
  cases: ConformanceCase[];
  limitations: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointerSegments(pointer: string): string[] {
  assert.match(pointer, /^\/(?:[^/]*(?:\/[^/]*)*)?$/);
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function pointerParent(target: JsonRecord, pointer: string): { parent: JsonRecord; key: string } {
  const segments = pointerSegments(pointer);
  assert.ok(segments.length > 0);
  let current: unknown = target;
  for (const segment of segments.slice(0, -1)) {
    assert.ok(isRecord(current), "JSON Pointer parent must be an object: " + pointer);
    current = current[segment];
  }
  assert.ok(isRecord(current), "JSON Pointer parent must be an object: " + pointer);
  return { parent: current, key: segments.at(-1) ?? "" };
}

function materialize(base: JsonRecord, patch: Pick<ConformanceCase, "set" | "remove">): JsonRecord {
  const value = structuredClone(base);
  for (const [pointer, entry] of Object.entries(patch.set)) {
    const { parent, key } = pointerParent(value, pointer);
    parent[key] = structuredClone(entry);
  }
  for (const pointer of patch.remove) {
    const { parent, key } = pointerParent(value, pointer);
    delete parent[key];
  }
  return value;
}

function runtimeAccepts(value: unknown): boolean {
  try {
    validateConfig(structuredClone(value));
    return true;
  } catch (error) {
    assert.ok(error instanceof ConfigError, "config rejection must use ConfigError");
    return false;
  }
}

async function loadContract(): Promise<{
  corpus: ConformanceCorpus;
  schema: Record<string, any>;
  schemaAccepts(value: unknown): boolean;
}> {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas", "launchrig.schema.json"), "utf8"),
  ) as Record<string, any>;
  const corpus = JSON.parse(
    await readFile(path.join(process.cwd(), ...CONFIG_V1_CONFORMANCE_PATH.split("/")), "utf8"),
  ) as ConformanceCorpus;
  const ajv = new Ajv2020({
    allErrors: true,
    strictSchema: true,
    strictNumbers: true,
    strictTypes: false,
    strictTuples: true,
    strictRequired: false,
    useDefaults: false,
    coerceTypes: false,
  });
  const validator = ajv.compile(schema);
  return {
    corpus,
    schema,
    schemaAccepts(value: unknown): boolean {
      return validator(structuredClone(value)) as boolean;
    },
  };
}

test("config v1 conformance corpus executes against runtime and Draft 2020-12 schema", async () => {
  const { corpus, schemaAccepts } = await loadContract();
  assert.deepEqual(Object.keys(corpus), [
    "schemaVersion",
    "kind",
    "configVersion",
    "status",
    "schemaPath",
    "parityCaseCount",
    "runtimeExtensionCaseCount",
    "grantMilestoneComplete",
    "base",
    "cases",
    "limitations",
  ]);
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.kind, "launchrig-config-v1-conformance");
  assert.equal(corpus.configVersion, 1);
  assert.equal(corpus.status, "pre-award-foundation");
  assert.equal(corpus.schemaPath, "schemas/launchrig.schema.json");
  assert.equal(corpus.grantMilestoneComplete, false);
  assert.equal(new Set(corpus.cases.map((entry) => entry.id)).size, corpus.cases.length);

  const parityCases = corpus.cases.filter((entry) => entry.classification === "parity");
  const extensionCases = corpus.cases.filter((entry) => entry.classification === "runtime-extension");
  assert.equal(parityCases.length, corpus.parityCaseCount);
  assert.equal(extensionCases.length, corpus.runtimeExtensionCaseCount);
  assert.equal(extensionCases.length, CONFIG_V1_RUNTIME_EXTENSIONS.length);

  for (const entry of corpus.cases) {
    const input = materialize(corpus.base, entry);
    const runtimeValid = runtimeAccepts(input);
    const schemaValid = schemaAccepts(input);
    assert.equal(runtimeValid, entry.runtimeValid, entry.id + " runtime result");
    assert.equal(schemaValid, entry.schemaValid, entry.id + " schema result");
    if (entry.classification === "parity") {
      assert.equal(runtimeValid, schemaValid, entry.id + " parity result");
    }
  }
});

test("config v1 metadata and runtime defaults stay synchronized", async () => {
  const { corpus, schema } = await loadContract();
  const properties = schema.properties;
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, CONFIG_V1_SCHEMA_ID);
  assert.equal(properties.version.const, CONFIG_V1_VERSION);
  assert.deepEqual(Object.keys(properties), [...CONFIG_ROOT_KEYS]);
  assert.deepEqual(schema.required, CONFIG_ROOT_KEYS.filter((key) => key !== "tooling"));
  assert.deepEqual(Object.keys(properties.project.properties), [...PROJECT_KEYS]);
  assert.deepEqual(Object.keys(properties.target.properties), [...TARGET_KEYS]);
  assert.deepEqual(Object.keys(properties.device.properties), [...DEVICE_KEYS]);
  assert.deepEqual(Object.keys(properties.wallet.properties), [...WALLET_KEYS]);
  assert.deepEqual(Object.keys(properties.scenarios.items.properties), [...SCENARIO_KEYS]);
  assert.deepEqual(Object.keys(properties.artifacts.properties), [...ARTIFACT_KEYS]);
  assert.deepEqual(Object.keys(properties.privacy.properties), [...PRIVACY_KEYS]);
  assert.deepEqual(Object.keys(properties.tooling.properties), [...TOOLING_KEYS]);
  assert.deepEqual(properties.target.properties.network.enum, [...CONFIG_NETWORKS]);
  assert.deepEqual(properties.project.properties.installPolicy.enum, [...INSTALL_POLICIES]);
  assert.deepEqual(properties.wallet.properties.installPolicy.enum, [...INSTALL_POLICIES]);
  assert.deepEqual(properties.wallet.properties.mode.enum, [...WALLET_MODES]);
  assert.deepEqual(properties.scenarios.items.properties.kind.enum, [...SCENARIO_KINDS]);
  assert.deepEqual(properties.artifacts.properties.screenshots.enum, [...SCREENSHOT_MODES]);
  assert.equal(properties.project.properties.packageName.pattern, ANDROID_APPLICATION_ID_PATTERN);
  assert.equal(properties.scenarios.items.properties.id.pattern, SCENARIO_ID_PATTERN);
  assert.equal(properties.device.properties.minimumApiLevel.minimum, CONFIG_V1_LIMITS.minimumApiLevel.minimum);
  assert.equal(properties.device.properties.minimumApiLevel.maximum, CONFIG_V1_LIMITS.minimumApiLevel.maximum);
  assert.equal(properties.scenarios.maxItems, CONFIG_V1_LIMITS.scenarioCount.maximum);
  assert.equal(
    properties.scenarios.items.properties.timeoutMs.minimum,
    CONFIG_V1_LIMITS.scenarioTimeoutMs.minimum,
  );
  assert.equal(
    properties.scenarios.items.properties.timeoutMs.maximum,
    CONFIG_V1_LIMITS.scenarioTimeoutMs.maximum,
  );
  assert.equal(properties.artifacts.properties.retention.minimum, CONFIG_V1_LIMITS.retention.minimum);
  assert.equal(properties.artifacts.properties.retention.maximum, CONFIG_V1_LIMITS.retention.maximum);
  assert.equal(properties.privacy.properties.logcatLines.minimum, CONFIG_V1_LIMITS.logcatLines.minimum);
  assert.equal(properties.privacy.properties.logcatLines.maximum, CONFIG_V1_LIMITS.logcatLines.maximum);
  assert.deepEqual(
    schema.allOf[1].then.properties.wallet.properties.packageName.enum,
    [...INSTALLABLE_TEST_WALLET_PACKAGES],
  );
  assert.equal(
    schema.allOf[3].if.properties.project.properties.packageName.const,
    REFERENCE_FAKEDAPP_PACKAGE,
  );
  assert.equal(schema.allOf[4].then.properties.wallet.properties.packageName.const, MOCK_MWA_PACKAGE);
  assert.equal(
    schema.allOf[5].then.properties.wallet.properties.packageName.const,
    REFERENCE_FAKEWALLET_PACKAGE,
  );
  assert.deepEqual(
    schema.allOf[6].if.properties.scenarios.contains.properties.kind.enum,
    [...MWA_SCENARIO_KINDS],
  );

  const normalized = validateConfig(corpus.base);
  assert.deepEqual(normalized, {
    version: 1,
    project: {
      name: "Fixture",
      packageName: "dev.launchrig.fixture",
      install: CONFIG_V1_DEFAULTS.projectInstall,
      installPolicy: CONFIG_V1_DEFAULTS.projectInstallPolicy,
    },
    target: { network: "devnet" },
    device: {
      requirePhysical: CONFIG_V1_DEFAULTS.requirePhysical,
      minimumApiLevel: CONFIG_V1_DEFAULTS.minimumApiLevel,
    },
    wallet: {
      mode: "mock-mwa",
      packageName: MOCK_MWA_PACKAGE,
      install: CONFIG_V1_DEFAULTS.walletInstall,
      installPolicy: CONFIG_V1_DEFAULTS.walletInstallPolicy,
    },
    scenarios: [],
    artifacts: {
      directory: "./.launchrig/results",
      screenshots: CONFIG_V1_DEFAULTS.screenshots,
      retention: CONFIG_V1_DEFAULTS.retention,
    },
    privacy: {
      includeLogcat: CONFIG_V1_DEFAULTS.includeLogcat,
      logcatLines: CONFIG_V1_DEFAULTS.logcatLines,
      redactPatterns: [],
    },
    tooling: {},
  });

  const defaultAssertions = [
    [properties.project.properties.install.default, CONFIG_V1_DEFAULTS.projectInstall],
    [properties.project.properties.installPolicy.default, CONFIG_V1_DEFAULTS.projectInstallPolicy],
    [properties.device.properties.requirePhysical.default, CONFIG_V1_DEFAULTS.requirePhysical],
    [properties.device.properties.minimumApiLevel.default, CONFIG_V1_DEFAULTS.minimumApiLevel],
    [properties.wallet.properties.install.default, CONFIG_V1_DEFAULTS.walletInstall],
    [properties.wallet.properties.installPolicy.default, CONFIG_V1_DEFAULTS.walletInstallPolicy],
    [properties.scenarios.items.properties.required.default, CONFIG_V1_DEFAULTS.scenarioRequired],
    [properties.scenarios.items.properties.timeoutMs.default, CONFIG_V1_DEFAULTS.scenarioTimeoutMs],
    [properties.artifacts.properties.screenshots.default, CONFIG_V1_DEFAULTS.screenshots],
    [properties.artifacts.properties.retention.default, CONFIG_V1_DEFAULTS.retention],
    [properties.privacy.properties.includeLogcat.default, CONFIG_V1_DEFAULTS.includeLogcat],
    [properties.privacy.properties.logcatLines.default, CONFIG_V1_DEFAULTS.logcatLines],
  ] as const;
  for (const [schemaDefault, runtimeDefault] of defaultAssertions) assert.equal(schemaDefault, runtimeDefault);
  assert.deepEqual(properties.privacy.properties.redactPatterns.default, []);
  assert.deepEqual(properties.tooling.default, {});
});

test("config v1 closes scalar, boundary, and whitespace acceptance drift", async () => {
  const { corpus, schemaAccepts } = await loadContract();
  const scenarios = Array.from({ length: 51 }, (_, index) => ({
    id: "scenario-" + index,
    kind: "custom",
    name: "Scenario " + index,
    flow: "./scenario-" + index + ".yaml",
  }));
  const cases: Array<{ id: string; set: Record<string, unknown>; remove: string[]; valid: boolean }> = [
    {
      id: "valid-upper-boundaries",
      set: {
        "/device/minimumApiLevel": 100,
        "/artifacts/retention": 25,
        "/privacy/logcatLines": 1000,
        "/scenarios": [
          {
            id: "custom-maximum",
            kind: "custom",
            name: "Maximum timeout",
            flow: "./maximum.yaml",
            timeoutMs: 600000,
          },
        ],
      },
      remove: [],
      valid: true,
    },
    { id: "missing-project-name", set: {}, remove: ["/project/name"], valid: false },
    { id: "missing-artifact-directory", set: {}, remove: ["/artifacts/directory"], valid: false },
    { id: "invalid-physical-flag", set: { "/device/requirePhysical": "yes" }, remove: [], valid: false },
    { id: "invalid-api-bound", set: { "/device/minimumApiLevel": 101 }, remove: [], valid: false },
    { id: "invalid-retention-bound", set: { "/artifacts/retention": 0 }, remove: [], valid: false },
    { id: "invalid-logcat-flag", set: { "/privacy/includeLogcat": "yes" }, remove: [], valid: false },
    { id: "invalid-logcat-bound", set: { "/privacy/logcatLines": 0 }, remove: [], valid: false },
    { id: "blank-project-name", set: { "/project/name": "  " }, remove: [], valid: false },
    { id: "empty-wallet-apk", set: { "/wallet/apk": "" }, remove: [], valid: false },
    { id: "null-project-install-policy", set: { "/project/installPolicy": null }, remove: [], valid: false },
    { id: "null-wallet-install-policy", set: { "/wallet/installPolicy": null }, remove: [], valid: false },
    { id: "null-screenshot-mode", set: { "/artifacts/screenshots": null }, remove: [], valid: false },
    { id: "blank-tooling-path", set: { "/tooling/maestro": " " }, remove: [], valid: false },
    {
      id: "padded-application-id",
      set: { "/project/packageName": " dev.launchrig.fixture " },
      remove: [],
      valid: false,
    },
    {
      id: "blank-scenario-name",
      set: {
        "/scenarios": [{ id: "blank-name", kind: "custom", name: " ", flow: "./flow.yaml" }],
      },
      remove: [],
      valid: false,
    },
    {
      id: "padded-scenario-id",
      set: {
        "/scenarios": [{ id: " padded ", kind: "custom", name: "Padded", flow: "./flow.yaml" }],
      },
      remove: [],
      valid: false,
    },
    {
      id: "scenario-timeout-below-minimum",
      set: {
        "/scenarios": [
          { id: "short-timeout", kind: "custom", name: "Short", flow: "./flow.yaml", timeoutMs: 999 },
        ],
      },
      remove: [],
      valid: false,
    },
    { id: "too-many-scenarios", set: { "/scenarios": scenarios }, remove: [], valid: false },
  ];
  for (const entry of cases) {
    const input = materialize(corpus.base, entry);
    assert.equal(runtimeAccepts(input), entry.valid, entry.id + " runtime result");
    assert.equal(schemaAccepts(input), entry.valid, entry.id + " schema result");
  }

  const freeForm = materialize(corpus.base, {
    set: {
      "/project/name": " Fixture with spacing ",
      "/artifacts/directory": " ./results with spaces ",
      "/tooling/adb": " /opt/android tools/adb ",
    },
    remove: [],
  });
  assert.equal(schemaAccepts(freeForm), true);
  const normalized = validateConfig(freeForm);
  assert.equal(normalized.project.name, " Fixture with spacing ");
  assert.equal(normalized.artifacts.directory, " ./results with spaces ");
  assert.equal(normalized.tooling.adb, " /opt/android tools/adb ");
});

test("config v1 mutation matrix has no undeclared runtime and schema divergence", async () => {
  const { corpus, schemaAccepts } = await loadContract();
  const scalarPaths = [
    "/version",
    "/project/name",
    "/project/packageName",
    "/project/apk",
    "/project/install",
    "/project/installPolicy",
    "/target/network",
    "/device/requirePhysical",
    "/device/minimumApiLevel",
    "/wallet/mode",
    "/wallet/packageName",
    "/wallet/apk",
    "/wallet/install",
    "/wallet/installPolicy",
    "/artifacts/directory",
    "/artifacts/screenshots",
    "/artifacts/retention",
    "/privacy/includeLogcat",
    "/privacy/logcatLines",
    "/tooling/adb",
    "/tooling/maestro",
  ] as const;
  const mutationValues: unknown[] = [
    undefined,
    null,
    "",
    " ",
    "x",
    "devnet",
    "testnet",
    "mock-mwa",
    "real",
    "always",
    "if-missing",
    "failure",
    "never",
    MOCK_MWA_PACKAGE,
    "dev.launchrig.fixture",
    "custom",
    "mwa-authorize",
    -1,
    0,
    1,
    22,
    23,
    26,
    100,
    101,
    999,
    1000,
    600000,
    600001,
    true,
    false,
    [],
    {},
  ];
  const divergences: string[] = [];

  for (const pointer of scalarPaths) {
    for (const value of mutationValues) {
      const patch = value === undefined ? { set: {}, remove: [pointer] } : { set: { [pointer]: value }, remove: [] };
      const input = materialize(corpus.base, patch);
      if (runtimeAccepts(input) !== schemaAccepts(input)) {
        divergences.push(pointer + " = " + JSON.stringify(value));
      }
    }
  }

  const scenarioBase: JsonRecord = {
    id: "case",
    kind: "custom",
    name: "Case",
    flow: "./case.yaml",
  };
  for (const key of SCENARIO_KEYS) {
    for (const value of mutationValues) {
      const scenario = structuredClone(scenarioBase);
      if (value === undefined) delete scenario[key];
      else scenario[key] = structuredClone(value);
      const input = materialize(corpus.base, { set: { "/scenarios": [scenario] }, remove: [] });
      if (runtimeAccepts(input) !== schemaAccepts(input)) {
        divergences.push("/scenarios[]." + key + " = " + JSON.stringify(value));
      }
    }
  }

  assert.deepEqual(divergences, []);
  assert.equal(scalarPaths.length * mutationValues.length + SCENARIO_KEYS.length * mutationValues.length, 891);
});

test("starter and tracked reference config satisfy both config v1 validators", async () => {
  const { schemaAccepts } = await loadContract();
  for (const [label, source] of [
    ["starter", STARTER_CONFIG],
    ["tracked reference", await readFile(path.join(process.cwd(), "launchrig.yml"), "utf8")],
  ] as const) {
    const value = parse(source);
    assert.equal(schemaAccepts(value), true, label + " JSON Schema result");
    assert.equal(runtimeAccepts(value), true, label + " runtime result");
  }
});
