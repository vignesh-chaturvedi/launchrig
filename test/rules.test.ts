import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import {
  getCoreRuleCatalog,
  PILOT_PREFLIGHT_CHECK_IDS,
  RUN_CHECK_IDS,
  scenarioCheckId,
} from "../src/rules/catalog.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map((entry) => canonicalJson(entry)).join(",") + "]";
  if (typeof value !== "object") throw new Error("Unsupported catalog value");
  const record = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]))
      .join(",") +
    "}"
  );
}

test("core rule catalog freezes 25 implemented rule definitions without claiming the funded milestone", () => {
  const catalog = getCoreRuleCatalog();
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.kind, "launchrig-core-rule-catalog");
  assert.equal(catalog.catalogVersion, 1);
  assert.equal(catalog.status, "pre-award-foundation");
  assert.equal(catalog.ruleCount, 25);
  assert.equal(catalog.rules.length, 25);
  assert.equal(catalog.grantMilestoneComplete, false);
  assert.deepEqual(
    Object.fromEntries(
      ["configuration", "runtime", "pilot"].map((domain) => [
        domain,
        catalog.rules.filter((rule) => rule.domain === domain).length,
      ]),
    ),
    { configuration: 5, runtime: 13, pilot: 7 },
  );
  assert.deepEqual(
    catalog.rules.map((rule) => rule.ruleId),
    Array.from({ length: 25 }, (_, index) => "LR" + String(index + 1).padStart(3, "0")),
  );
  assert.equal(new Set(catalog.rules.map((rule) => rule.checkId)).size, 25);
  assert.ok(catalog.limitations.some((entry) => entry.includes("not been reviewed or released")));
  assert.ok(catalog.limitations.some((entry) => entry.includes("does not establish Seeker")));
});

test("catalog covers every centralized runtime and pilot check identifier", () => {
  const checkIds = new Set(getCoreRuleCatalog().rules.map((rule) => rule.checkId));
  for (const checkId of Object.values(RUN_CHECK_IDS)) assert.ok(checkIds.has(checkId), checkId);
  for (const checkId of Object.values(PILOT_PREFLIGHT_CHECK_IDS)) assert.ok(checkIds.has(checkId), checkId);
  assert.equal(scenarioCheckId("authorize"), "scenario.authorize");
  assert.equal(checkIds.has("scenario.*"), true);
});

test("catalog digest is deterministic and returned objects cannot mutate the source contract", () => {
  const catalog = getCoreRuleCatalog();
  const { catalogSha256, ...core } = catalog;
  assert.equal(
    catalogSha256,
    createHash("sha256").update(canonicalJson(core)).digest("hex"),
  );
  catalog.rules[0]!.title = "mutated";
  catalog.limitations[0] = "mutated";
  const fresh = getCoreRuleCatalog();
  assert.notEqual(fresh.rules[0]?.title, "mutated");
  assert.notEqual(fresh.limitations[0], "mutated");
  assert.equal(fresh.catalogSha256, catalogSha256);
});

test("catalog source and test mappings resolve in the source checkout", async () => {
  const catalog = getCoreRuleCatalog();
  for (const rule of catalog.rules) {
    const [source] = rule.implementation.split("#");
    assert.ok(source);
    await readFile(path.join(root, ...source.split("/")), "utf8");
    await readFile(path.join(root, ...rule.testContract.split("/")), "utf8");
  }
});

test("core rule catalog schema preserves the exact pre-award contract", async () => {
  const schema = JSON.parse(
    await readFile(path.join(root, "schemas", "launchrig-core-rule-catalog.schema.json"), "utf8"),
  ) as Record<string, any>;
  assert.equal(schema.$id, "https://launchrig.dev/schemas/launchrig-core-rule-catalog.schema.json");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.kind.const, "launchrig-core-rule-catalog");
  assert.equal(schema.properties.status.const, "pre-award-foundation");
  assert.equal(schema.properties.ruleCount.const, 25);
  assert.equal(schema.properties.rules.minItems, 25);
  assert.equal(schema.properties.rules.maxItems, 25);
  assert.equal(schema.properties.grantMilestoneComplete.const, false);
  assert.equal(schema.$defs.rule.additionalProperties, false);
});

test("rules CLI renders deterministic human and JSON output and rejects unrelated input", async () => {
  const humanOutput: string[] = [];
  const errors: string[] = [];
  assert.equal(
    await runCli(["rules"], {
      out: (message) => humanOutput.push(message),
      error: (message) => errors.push(message),
    }),
    0,
  );
  assert.match(humanOutput.join("\n"), /LaunchRig core rule catalog v1/);
  assert.match(humanOutput.join("\n"), /LR025 pilot\.environment/);
  assert.match(humanOutput.join("\n"), /grant milestone complete: no/);
  assert.equal(errors.length, 0);

  const jsonOutput: string[] = [];
  assert.equal(
    await runCli(["rules", "--json"], {
      out: (message) => jsonOutput.push(message),
      error: (message) => errors.push(message),
    }),
    0,
  );
  const parsed = JSON.parse(jsonOutput.join("\n"));
  assert.equal(parsed.ruleCount, 25);
  assert.equal(parsed.grantMilestoneComplete, false);

  for (const argv of [["rules", "extra"], ["rules", "--config", "launchrig.yml"]]) {
    const invalidErrors: string[] = [];
    assert.equal(
      await runCli(argv, {
        out: () => undefined,
        error: (message) => invalidErrors.push(message),
      }),
      2,
    );
    assert.ok(invalidErrors.length > 0);
  }
});
