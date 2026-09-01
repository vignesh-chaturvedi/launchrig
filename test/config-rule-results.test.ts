import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { stringify } from "yaml";
import { validateProject, type ValidationOutput } from "../src/commands/validate.js";
import {
  configDiagnostic,
  CONFIG_RULE_CHECK_IDS,
  CONFIG_RULE_IDS,
  type ConfigRuleId,
} from "../src/config/diagnostics.js";

type JsonRecord = Record<string, unknown>;

interface RuleFixtureCase {
  id: string;
  targetRule: ConfigRuleId;
  set: Record<string, unknown>;
  remove: string[];
  omitFiles: string[];
  replaceFiles: Record<string, string>;
  expectedValid: boolean;
  expectedStatuses: Array<"passed" | "failed" | "not-evaluated">;
  expectedDiagnosticCodes: string[];
}

test("configuration diagnostics bound and normalize human messages", () => {
  const diagnostic = configDiagnostic(
    "LR001",
    "config.schema.invalid-field",
    "config",
    "\u0000" + "x".repeat(5000),
  );
  assert.equal(diagnostic.message.length, 4000);
  assert.doesNotMatch(diagnostic.message, /[\u0000-\u001f\u007f]/);
  assert.equal(diagnostic.ruleId, "LR001");
  assert.equal(diagnostic.checkId, "config.schema");
});

interface RuleFixtureCorpus {
  schemaVersion: number;
  kind: string;
  profile: string;
  status: string;
  ruleIds: ConfigRuleId[];
  caseCount: number;
  grantMilestoneComplete: boolean;
  base: JsonRecord;
  baseFiles: Record<string, string>;
  cases: RuleFixtureCase[];
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

function materializeConfig(base: JsonRecord, fixture: RuleFixtureCase): JsonRecord {
  const value = structuredClone(base);
  for (const [pointer, entry] of Object.entries(fixture.set)) {
    const { parent, key } = pointerParent(value, pointer);
    parent[key] = structuredClone(entry);
  }
  for (const pointer of fixture.remove) {
    const { parent, key } = pointerParent(value, pointer);
    delete parent[key];
  }
  return value;
}

async function loadRuleFixtureContract(): Promise<{
  corpus: RuleFixtureCorpus;
  acceptsResult(value: unknown): boolean;
}> {
  const schema = JSON.parse(
    await readFile(
      path.join(process.cwd(), "schemas", "launchrig-config-validation-result.schema.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const corpus = JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "schemas",
        "fixtures",
        "launchrig-config-rule-fixtures.v1.json",
      ),
      "utf8",
    ),
  ) as RuleFixtureCorpus;
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
    acceptsResult(value: unknown): boolean {
      return validator(structuredClone(value)) as boolean;
    },
  };
}

async function materializeFixture(
  directory: string,
  corpus: RuleFixtureCorpus,
  fixture: RuleFixtureCase,
): Promise<string> {
  const omitted = new Set(fixture.omitFiles);
  for (const [relativePath, source] of Object.entries(corpus.baseFiles)) {
    if (omitted.has(relativePath)) continue;
    const destination = path.join(directory, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, fixture.replaceFiles[relativePath] ?? source, "utf8");
  }
  for (const [relativePath, source] of Object.entries(fixture.replaceFiles)) {
    if (Object.hasOwn(corpus.baseFiles, relativePath) || omitted.has(relativePath)) continue;
    const destination = path.join(directory, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source, "utf8");
  }
  const configPath = path.join(directory, "launchrig.yml");
  await writeFile(configPath, stringify(materializeConfig(corpus.base, fixture)), "utf8");
  return configPath;
}

function assertStableResult(
  output: ValidationOutput,
  fixture: RuleFixtureCase,
  configPath: string,
  acceptsResult: (value: unknown) => boolean,
): void {
  assert.equal(acceptsResult(output), true, fixture.id + " result schema");
  assert.equal(output.valid, fixture.expectedValid, fixture.id + " validity");
  assert.equal(output.configPath, configPath, fixture.id + " config path");
  assert.equal(output.grantMilestoneComplete, false, fixture.id + " grant boundary");
  assert.deepEqual(
    output.ruleResults.map((entry) => entry.ruleId),
    CONFIG_RULE_IDS,
    fixture.id + " rule order",
  );
  assert.deepEqual(
    output.ruleResults.map((entry) => entry.checkId),
    CONFIG_RULE_IDS.map((ruleId) => CONFIG_RULE_CHECK_IDS[ruleId]),
    fixture.id + " check order",
  );
  assert.deepEqual(
    output.ruleResults.map((entry) => entry.status),
    fixture.expectedStatuses,
    fixture.id + " statuses",
  );
  assert.deepEqual(
    output.diagnostics.map((entry) => entry.code),
    fixture.expectedDiagnosticCodes,
    fixture.id + " diagnostic codes",
  );
  assert.deepEqual(
    output.issues,
    output.diagnostics.map((entry) => entry.message),
    fixture.id + " issue compatibility",
  );
  for (const result of output.ruleResults) {
    assert.equal(
      result.diagnosticCount,
      output.diagnostics.filter((entry) => entry.ruleId === result.ruleId).length,
      fixture.id + " diagnostic count " + result.ruleId,
    );
  }
  for (const diagnostic of output.diagnostics) {
    assert.equal(diagnostic.checkId, CONFIG_RULE_CHECK_IDS[diagnostic.ruleId]);
    assert.equal(diagnostic.path.includes(configPath), false, fixture.id + " logical path");
    assert.equal(diagnostic.message.includes(path.dirname(configPath)), false, fixture.id + " stable message");
  }
}

test("LR001 through LR005 fixture corpus is complete and deterministic", async () => {
  const { corpus, acceptsResult } = await loadRuleFixtureContract();
  assert.deepEqual(Object.keys(corpus), [
    "schemaVersion",
    "kind",
    "profile",
    "status",
    "ruleIds",
    "caseCount",
    "grantMilestoneComplete",
    "base",
    "baseFiles",
    "cases",
    "limitations",
  ]);
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.kind, "launchrig-config-rule-fixtures");
  assert.equal(corpus.profile, "config-rules-v1");
  assert.equal(corpus.status, "pre-award-foundation");
  assert.deepEqual(corpus.ruleIds, CONFIG_RULE_IDS);
  assert.equal(corpus.caseCount, 10);
  assert.equal(corpus.cases.length, corpus.caseCount);
  assert.equal(corpus.grantMilestoneComplete, false);
  assert.equal(new Set(corpus.cases.map((entry) => entry.id)).size, corpus.caseCount);
  assert.ok(corpus.limitations.length > 0);

  const positiveCoverage = new Set<ConfigRuleId>();
  const negativeCoverage = new Set<ConfigRuleId>();
  const root = await mkdtemp(path.join(os.tmpdir(), "launchrig-config-rules-"));
  try {
    for (const fixture of corpus.cases) {
      const directory = path.join(root, fixture.id);
      await mkdir(directory, { recursive: true });
      const configPath = await materializeFixture(directory, corpus, fixture);
      const first = await validateProject(configPath);
      const second = await validateProject(configPath);
      assert.deepEqual(second, first, fixture.id + " deterministic rerun");
      assertStableResult(first, fixture, configPath, acceptsResult);
      for (const result of first.ruleResults) {
        if (result.status === "passed") positiveCoverage.add(result.ruleId);
        if (result.status === "failed") negativeCoverage.add(result.ruleId);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual([...positiveCoverage].sort(), [...CONFIG_RULE_IDS].sort());
  assert.deepEqual([...negativeCoverage].sort(), [...CONFIG_RULE_IDS].sort());
});
