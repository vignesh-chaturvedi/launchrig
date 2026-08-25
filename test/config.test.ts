import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initProject } from "../src/commands/init.js";
import { loadConfig, validateConfigPaths } from "../src/config/load.js";
import { ConfigError, validateConfig } from "../src/config/schema.js";

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
