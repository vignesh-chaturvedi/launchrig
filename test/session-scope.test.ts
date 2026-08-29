import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import {
  createPilotSessionScopeReceipt,
  PilotSessionScopeError,
  type PilotSessionScopeV1,
} from "../src/pilot/session-scope.js";

function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function scope(): PilotSessionScopeV1 {
  return {
    schemaVersion: 1,
    kind: "launchrig-pilot-session-scope",
    profile: "external-mwa-pilot-scope-v1",
    scopeRef: "urn:launchrig:scope:123e4567-e89b-42d3-a456-426614174000",
    operatorRef: "urn:launchrig:operator:223e4567-e89b-42d3-a456-426614174000",
    pilotRef: "urn:launchrig:pilot:323e4567-e89b-42d3-a456-426614174000",
    deviceRef: "urn:launchrig:device:423e4567-e89b-42d3-a456-426614174000",
    bundle: {
      bundleId: "sha256:" + digest("bundle"),
      manifestSha256: digest("manifest"),
      sha256SumsSha256: digest("sums"),
      packageSha256: digest("package"),
    },
    inputs: {
      configSha256: digest("config"),
      appBuildSha256: digest("app"),
      walletArtifactSha256: digest("wallet"),
      flows: [
        { kind: "mwa-authorize", scenarioId: "authorize", fileSha256: digest("authorize") },
        { kind: "mwa-siws", scenarioId: "siws", fileSha256: digest("siws") },
        { kind: "mwa-sign-message", scenarioId: "sign-message", fileSha256: digest("sign-message") },
        { kind: "mwa-reject", scenarioId: "reject", fileSha256: digest("reject") },
      ],
    },
    policy: {
      network: "devnet",
      walletMode: "mock-mwa",
      physicalAndroidRequired: true,
      attendedExecutionRequired: true,
      manualWalletActionsRequired: true,
      valuableAssetsAllowed: false,
      capture: {
        screenshots: "failure",
        includeLogcat: false,
        logcatLines: 200,
      },
      retention: {
        maxRuns: 5,
        expiresOn: "2026-12-31",
        deletionMethod: "standard-delete",
      },
      sharing: {
        publicEvidenceJson: true,
        sanitizedReports: false,
        publisherName: false,
        publisherLogo: false,
        approvedQuote: false,
        confirmedDefectRecord: false,
      },
    },
  };
}

async function writeScope(
  directory: string,
  name: string,
  value: unknown,
  source?: string,
): Promise<string> {
  const target = path.join(directory, name);
  await writeFile(target, source ?? JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(target, 0o600);
  return target;
}

test("session scope receipt is canonical, path-free, and register-compatible", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-session-scope-"));
  try {
    const firstScope = scope();
    const firstPath = await writeScope(directory, "private-scope-canary.json", firstScope);
    const first = await createPilotSessionScopeReceipt(firstPath);

    const reordered = {
      policy: firstScope.policy,
      inputs: { ...firstScope.inputs, flows: [...firstScope.inputs.flows].reverse() },
      bundle: firstScope.bundle,
      deviceRef: firstScope.deviceRef,
      pilotRef: firstScope.pilotRef,
      operatorRef: firstScope.operatorRef,
      scopeRef: firstScope.scopeRef,
      profile: firstScope.profile,
      kind: firstScope.kind,
      schemaVersion: firstScope.schemaVersion,
    };
    const secondPath = await writeScope(
      directory,
      "private-reordered-canary.json",
      reordered,
      JSON.stringify(reordered) + "\n",
    );
    const second = await createPilotSessionScopeReceipt(secondPath);

    assert.deepEqual(first.binding, second.binding);
    assert.deepEqual(first.bundleVerification, second.bundleVerification);
    assert.notEqual(first.scopeFileSha256, second.scopeFileSha256);
    assert.equal(first.policyValid, true);
    assert.equal(first.claimStatus, "operator-prepared-unattested");
    assert.equal(first.publisherIdentity, "not-established");
    assert.equal(first.consentAuthenticity, "not-established");
    assert.equal(first.deviceEnvironment, "not-established");
    assert.equal(first.externalGrantGate, "not-established");
    assert.equal(first.grantReady, false);
    assert.deepEqual(Object.keys(first.binding).sort(), [
      "appBuildSha256",
      "bundleId",
      "flowReviewSha256",
      "packageSha256",
      "scopeSha256",
      "walletArtifactSha256",
    ]);
    const rendered = JSON.stringify(first);
    assert.doesNotMatch(rendered, /private-scope-canary|urn:launchrig:|authorize|sign-message/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pilot scope CLI renders human and JSON receipts without private values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-session-scope-cli-"));
  try {
    const target = await writeScope(directory, "cli-private-path-canary.json", scope());
    for (const json of [false, true]) {
      const output: string[] = [];
      const errors: string[] = [];
      const exitCode = await runCli(
        ["pilot", "scope", target, ...(json ? ["--json"] : [])],
        { out: (message) => output.push(message), error: (message) => errors.push(message) },
      );
      assert.equal(exitCode, 0);
      assert.equal(errors.length, 0);
      const rendered = output.join("\n");
      assert.doesNotMatch(rendered, /cli-private-path-canary|urn:launchrig:|123e4567|223e4567/);
      assert.match(rendered, json ? /"grantReady": false/ : /grant ready: no/);
      if (json) {
        const receipt = JSON.parse(rendered) as Record<string, any>;
        assert.equal(receipt.kind, "launchrig-pilot-session-scope-receipt");
        assert.equal(receipt.binding.scopeSha256.length, 64);
      }
    }

    const privateOptionValue = path.join(directory, "option-value-canary.json");
    for (const [argument, expectedName] of [
      ["--config=" + privateOptionValue, "--config"],
      ["-c" + privateOptionValue, "-c"],
      ["-dPHONE-SERIAL-CANARY", "-d"],
    ] as const) {
      const errorOutput: string[] = [];
      const exitCode = await runCli(
        ["pilot", "scope", target, argument],
        { out: () => undefined, error: (message) => errorOutput.push(message) },
      );
      assert.equal(exitCode, 2);
      assert.match(errorOutput.join("\n"), new RegExp("pilot scope does not accept " + expectedName));
      assert.doesNotMatch(errorOutput.join("\n"), /option-value-canary|PHONE-SERIAL-CANARY/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("every material session scope field is bound or rejected by safe policy", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-session-scope-mutations-"));
  try {
    const baselineScope = scope();
    const baselinePath = await writeScope(directory, "baseline.json", baselineScope);
    const baseline = await createPilotSessionScopeReceipt(baselinePath);
    const mutations: Array<(value: PilotSessionScopeV1) => void> = [
      (value) => { value.scopeRef = "urn:launchrig:scope:523e4567-e89b-42d3-a456-426614174000"; },
      (value) => { value.operatorRef = "urn:launchrig:operator:623e4567-e89b-42d3-a456-426614174000"; },
      (value) => { value.pilotRef = "urn:launchrig:pilot:723e4567-e89b-42d3-a456-426614174000"; },
      (value) => { value.deviceRef = "urn:launchrig:device:823e4567-e89b-42d3-a456-426614174000"; },
      (value) => { value.bundle.bundleId = "sha256:" + digest("bundle-next"); },
      (value) => { value.bundle.manifestSha256 = digest("manifest-next"); },
      (value) => { value.bundle.sha256SumsSha256 = digest("sums-next"); },
      (value) => { value.bundle.packageSha256 = digest("package-next"); },
      (value) => { value.inputs.configSha256 = digest("config-next"); },
      (value) => { value.inputs.appBuildSha256 = digest("app-next"); },
      (value) => { value.inputs.walletArtifactSha256 = digest("wallet-next"); },
      (value) => { value.inputs.flows[0]!.fileSha256 = digest("authorize-next"); },
      (value) => {
        const first = value.inputs.flows[0]!;
        const second = value.inputs.flows[1]!;
        [first.scenarioId, second.scenarioId] = [second.scenarioId, first.scenarioId];
      },
      (value) => { value.policy.network = "testnet"; },
      (value) => { value.policy.walletMode = "reference-fakewallet"; },
      (value) => { value.policy.capture.screenshots = "never"; },
      (value) => { value.policy.capture.includeLogcat = true; },
      (value) => { value.policy.capture.logcatLines = 201; },
      (value) => { value.policy.retention.maxRuns = 6; },
      (value) => { value.policy.retention.expiresOn = "2027-01-01"; },
      (value) => { value.policy.retention.deletionMethod = "publisher-managed"; },
      (value) => { value.policy.sharing.publicEvidenceJson = false; },
      (value) => { value.policy.sharing.sanitizedReports = true; },
      (value) => { value.policy.sharing.publisherName = true; },
      (value) => { value.policy.sharing.publisherLogo = true; },
      (value) => { value.policy.sharing.approvedQuote = true; },
      (value) => { value.policy.sharing.confirmedDefectRecord = true; },
    ];

    for (const [index, mutate] of mutations.entries()) {
      const changed = structuredClone(baselineScope);
      mutate(changed);
      const target = await writeScope(directory, "mutation-" + index + ".json", changed);
      const receipt = await createPilotSessionScopeReceipt(target);
      assert.notEqual(receipt.binding.scopeSha256, baseline.binding.scopeSha256, "mutation " + index);
    }

    const unsafePolicies: Array<(value: Record<string, any>) => void> = [
      (value) => { value.policy.physicalAndroidRequired = false; },
      (value) => { value.policy.attendedExecutionRequired = false; },
      (value) => { value.policy.manualWalletActionsRequired = false; },
      (value) => { value.policy.valuableAssetsAllowed = true; },
      (value) => { value.policy.network = "mainnet"; },
      (value) => { value.policy.walletMode = "real"; },
    ];
    for (const [index, mutate] of unsafePolicies.entries()) {
      const changed = structuredClone(baselineScope) as unknown as Record<string, any>;
      mutate(changed);
      const target = await writeScope(directory, "unsafe-" + index + ".json", changed);
      await assert.rejects(
        () => createPilotSessionScopeReceipt(target),
        (error: unknown) => error instanceof PilotSessionScopeError && error.exitCode === 2,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session scope parser rejects malformed policy and private file hazards without path leakage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-session-scope-hazards-"));
  try {
    const base = scope();
    const cases: Array<[string, unknown]> = [
      ["unknown", { ...base, privateName: "publisher-canary" }],
      ["bad-ref", { ...base, scopeRef: "publisher@example.com" }],
      ["bad-hash", { ...base, bundle: { ...base.bundle, packageSha256: "A".repeat(64) } }],
      ["bad-date", { ...base, policy: { ...base.policy, retention: { ...base.policy.retention, expiresOn: "2026-02-30" } } }],
      ["duplicate-flow", { ...base, inputs: { ...base.inputs, flows: [base.inputs.flows[0], base.inputs.flows[0], base.inputs.flows[2], base.inputs.flows[3]] } }],
      ["duplicate-digest", { ...base, inputs: { ...base.inputs, flows: base.inputs.flows.map((flow, index) => index === 1 ? { ...flow, fileSha256: base.inputs.flows[0]!.fileSha256 } : flow) } }],
    ];
    for (const [name, value] of cases) {
      const target = await writeScope(directory, name + ".json", value);
      await assert.rejects(
        () => createPilotSessionScopeReceipt(target),
        (error: unknown) =>
          error instanceof PilotSessionScopeError &&
          error.exitCode === 2 &&
          !error.message.includes(target) &&
          !error.message.includes("publisher-canary"),
      );
    }

    const duplicateKey = path.join(directory, "duplicate-key-canary.json");
    await writeFile(duplicateKey, '{"schemaVersion":1,"schemaVersion":1}\n', { mode: 0o600 });
    await chmod(duplicateKey, 0o600);
    await assert.rejects(
      () => createPilotSessionScopeReceipt(duplicateKey),
      (error: unknown) => error instanceof PilotSessionScopeError && error.message.includes("duplicate keys"),
    );

    const unsafeMode = await writeScope(directory, "unsafe-mode-canary.json", base);
    await chmod(unsafeMode, 0o644);
    await assert.rejects(
      () => createPilotSessionScopeReceipt(unsafeMode),
      (error: unknown) => error instanceof PilotSessionScopeError && error.exitCode === 3 && !error.message.includes(unsafeMode),
    );

    const safeForLink = await writeScope(directory, "safe-for-link.json", base);
    const linked = path.join(directory, "symlink-canary.json");
    await symlink(safeForLink, linked);
    await assert.rejects(
      () => createPilotSessionScopeReceipt(linked),
      (error: unknown) => error instanceof PilotSessionScopeError && error.exitCode === 3 && !error.message.includes(linked),
    );

    const safeForHardlink = await writeScope(directory, "safe-for-hardlink.json", base);
    const hardlink = path.join(directory, "hardlink-canary.json");
    await link(safeForHardlink, hardlink);
    await assert.rejects(
      () => createPilotSessionScopeReceipt(safeForHardlink),
      (error: unknown) => error instanceof PilotSessionScopeError && error.exitCode === 3,
    );

    const nestedDirectory = path.join(directory, "directory-canary.json");
    await mkdir(nestedDirectory);
    await assert.rejects(
      () => createPilotSessionScopeReceipt(nestedDirectory),
      (error: unknown) => error instanceof PilotSessionScopeError && error.exitCode === 3,
    );

    const empty = path.join(directory, "empty-canary.json");
    await writeFile(empty, "", { mode: 0o600 });
    await assert.rejects(
      () => createPilotSessionScopeReceipt(empty),
      (error: unknown) => error instanceof PilotSessionScopeError && error.exitCode === 3,
    );

    const invalidUtf8 = path.join(directory, "utf8-canary.json");
    await writeFile(invalidUtf8, Buffer.from([0xff, 0xfe, 0xfd]), { mode: 0o600 });
    await chmod(invalidUtf8, 0o600);
    await assert.rejects(
      () => createPilotSessionScopeReceipt(invalidUtf8),
      (error: unknown) => error instanceof PilotSessionScopeError && error.message.includes("valid UTF-8"),
    );

    const oversized = path.join(directory, "oversized-canary.json");
    await writeFile(oversized, Buffer.alloc(256 * 1024 + 1, 0x20), { mode: 0o600 });
    await chmod(oversized, 0o600);
    await assert.rejects(
      () => createPilotSessionScopeReceipt(oversized),
      (error: unknown) => error instanceof PilotSessionScopeError && error.exitCode === 3,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session scope stable reader returns only complete versions during concurrent mutation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-session-scope-race-"));
  try {
    const firstScope = scope();
    const secondScope = scope();
    secondScope.bundle.packageSha256 = digest("package-second");
    const target = await writeScope(directory, "race.json", firstScope, JSON.stringify(firstScope) + "\n");
    const firstReceipt = await createPilotSessionScopeReceipt(target);
    await writeFile(target, JSON.stringify(secondScope) + "\n", { mode: 0o600 });
    await chmod(target, 0o600);
    const secondReceipt = await createPilotSessionScopeReceipt(target);
    const accepted = new Set([firstReceipt.binding.scopeSha256, secondReceipt.binding.scopeSha256]);

    const writer = (async () => {
      for (let index = 0; index < 30; index += 1) {
        await writeFile(target, JSON.stringify(index % 2 === 0 ? firstScope : secondScope) + "\n", { mode: 0o600 });
      }
    })();
    const receipts = [];
    for (let index = 0; index < 30; index += 1) {
      try {
        receipts.push(await createPilotSessionScopeReceipt(target));
      } catch (error) {
        assert.ok(error instanceof PilotSessionScopeError);
      }
    }
    await writer;
    receipts.push(await createPilotSessionScopeReceipt(target));
    assert.ok(receipts.length > 0);
    for (const receipt of receipts) assert.ok(accepted.has(receipt.binding.scopeSha256));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
