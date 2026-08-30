import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { runCli } from "../src/cli.js";
import { preparePilotSessionScope, type PreparePilotSessionScopeOptions } from "../src/pilot/scope-preparation.js";
import { PilotSessionScopeError } from "../src/pilot/session-scope.js";

const MANAGED_WALLET_SHA256 = "b9b28b4936f388f615febc493e0af5c7e8c40002de4a3cddbef4f52315a9ef3b";
const OUTER_BUNDLE_COPY_MAP = [
  ["docs/publisher-bundle-readme.md", "README.md"],
  ["docs/publisher-pilot-quickstart.md", "docs/publisher-pilot-quickstart.md"],
  ["docs/supported-environment.md", "docs/supported-environment.md"],
  ["docs/flows/mwa-authorize.md", "docs/flows/mwa-authorize.md"],
  ["docs/flows/mwa-reject.md", "docs/flows/mwa-reject.md"],
  ["docs/flows/mwa-sign-message.md", "docs/flows/mwa-sign-message.md"],
  ["docs/flows/mwa-siws.md", "docs/flows/mwa-siws.md"],
  ["schemas/launchrig-publisher-bundle.schema.json", "schemas/launchrig-publisher-bundle.schema.json"],
  ["templates/defect-evidence.md", "templates/defect-evidence.md"],
  ["templates/pilot-consent.md", "templates/pilot-consent.md"],
  ["templates/pilot-notes.md", "templates/pilot-notes.md"],
  ["templates/publisher-intake.md", "templates/publisher-intake.md"],
  ["templates/sharing-review.md", "templates/sharing-review.md"],
] as const;

interface PayloadEntry {
  path: string;
  sizeBytes: number;
  sha256: string;
}

interface BundleLibrary {
  collectPayloadEntries(directory: string): Promise<PayloadEntry[]>;
  createPublisherManifest(options: {
    launchRigVersion: string;
    gitCommit: string;
    lockfileSha256: string;
    nodeEngine: string;
    packageManager: string;
    packagePath: string;
    files: PayloadEntry[];
  }): Record<string, unknown>;
  renderSha256Sums(files: PayloadEntry[]): string;
}

let bundleWorkspace = "";
let verifiedBundleDirectory = "";

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const errors: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(errors).toString("utf8") || command + " failed"));
    });
  });
}

before(async () => {
  bundleWorkspace = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "launchrig-prepare-scope-bundle-")),
  );
  const packDirectory = path.join(bundleWorkspace, "pack");
  verifiedBundleDirectory = path.join(bundleWorkspace, "verified-bundle");
  await mkdir(packDirectory, { mode: 0o700 });
  await mkdir(verifiedBundleDirectory, { mode: 0o700 });
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  await run(pnpm, ["pack", "--pack-destination", packDirectory]);
  const archives = (await readdir(packDirectory)).filter((entry) => entry.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  const packageMetadata = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
    version: string;
    engines: { node: string };
    packageManager: string;
  };
  const archiveName = "launchrig-" + packageMetadata.version + ".tgz";
  assert.equal(archives[0], archiveName);
  await copyFile(path.join(packDirectory, archiveName), path.join(verifiedBundleDirectory, archiveName));
  for (const [source, destination] of OUTER_BUNDLE_COPY_MAP) {
    const target = path.join(verifiedBundleDirectory, ...destination.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path.join(process.cwd(), ...source.split("/")), target);
  }
  const bundleLibrary = (await import(
    pathToFileURL(path.join(process.cwd(), "scripts", "pilot-bundle-lib.mjs")).href
  )) as BundleLibrary;
  const files = await bundleLibrary.collectPayloadEntries(verifiedBundleDirectory);
  const manifest = bundleLibrary.createPublisherManifest({
    launchRigVersion: packageMetadata.version,
    gitCommit: "a".repeat(40),
    lockfileSha256: "b".repeat(64),
    nodeEngine: packageMetadata.engines.node,
    packageManager: packageMetadata.packageManager,
    packagePath: archiveName,
    files,
  });
  await writeFile(
    path.join(verifiedBundleDirectory, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    path.join(verifiedBundleDirectory, "SHA256SUMS"),
    bundleLibrary.renderSha256Sums(files),
    { flag: "wx", mode: 0o600 },
  );
});

after(async () => {
  if (bundleWorkspace) await rm(bundleWorkspace, { recursive: true, force: true });
});

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writePublisherProject(directory: string): Promise<{
  configPath: string;
  appBytes: Buffer;
  flowBytes: Record<string, Buffer>;
}> {
  const packageName = "com.publisher.launchrig";
  const appBytes = Buffer.from("publisher app apk bytes\n", "utf8");
  await writeFile(path.join(directory, "publisher.apk"), appBytes);
  const scenarios = [
    ["authorize", "mwa-authorize"],
    ["siws", "mwa-siws"],
    ["sign-message", "mwa-sign-message"],
    ["reject", "mwa-reject"],
  ] as const;
  const flowBytes: Record<string, Buffer> = {};
  for (const [id] of scenarios) {
    const bytes = Buffer.from(
      [
        "appId: " + packageName,
        "name: " + id,
        "---",
        "- launchApp:",
        "    clearState: false",
        "- assertVisible:",
        "    id: publisher-" + id + "-ready",
        "",
      ].join("\n"),
      "utf8",
    );
    flowBytes[id] = bytes;
    await writeFile(path.join(directory, id + ".yaml"), bytes);
  }
  const configPath = path.join(directory, "launchrig.yml");
  await writeFile(
    configPath,
    [
      "version: 1",
      "project:",
      "  name: Publisher LaunchRig",
      "  packageName: " + packageName,
      "  apk: ./publisher.apk",
      "  install: false",
      "target:",
      "  network: devnet",
      "device:",
      "  requirePhysical: true",
      "  minimumApiLevel: 26",
      "wallet:",
      "  mode: mock-mwa",
      "  packageName: com.solana.mwallet",
      "  install: false",
      "scenarios:",
      ...scenarios.flatMap(([id, kind]) => [
        "  - id: " + id,
        "    kind: " + kind,
        "    name: " + id,
        "    flow: ./" + id + ".yaml",
        "    required: true",
      ]),
      "artifacts:",
      "  directory: ./.launchrig/results",
      "  screenshots: failure",
      "  retention: 5",
      "privacy:",
      "  includeLogcat: false",
      "  logcatLines: 200",
      "  redactPatterns: []",
      "tooling: {}",
      "",
    ].join("\n"),
    "utf8",
  );
  return { configPath, appBytes, flowBytes };
}

function options(
  directory: string,
  configPath: string,
  outputName = "private-scope.json",
): PreparePilotSessionScopeOptions {
  return {
    configPath,
    bundleDirectory: verifiedBundleDirectory,
    expiresOn: "2099-12-31",
    deletionMethod: "publisher-managed",
    outputPath: path.join(directory, outputName),
  };
}

test("prepare-scope derives exact private inputs with safe defaults and a strict result", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "launchrig-prepare-scope-")));
  try {
    const project = await writePublisherProject(directory);
    const prepareOptions = options(directory, project.configPath);
    const result = await preparePilotSessionScope(prepareOptions);
    assert.equal(result.kind, "launchrig-pilot-session-scope-draft-result");
    assert.equal(result.status, "created");
    assert.equal(result.reviewRequired, true);
    assert.equal(result.approvalReceiptCreated, false);
    assert.equal(result.pilotStateChecked, false);
    assert.equal(result.deviceEnvironmentChecked, false);
    assert.equal(result.bundleAuthenticity, "not-established");
    assert.equal(result.grantReady, false);

    const source = await readFile(prepareOptions.outputPath);
    const scope = JSON.parse(source.toString("utf8")) as Record<string, any>;
    assert.equal(result.scopeFileSha256, digest(source));
    assert.equal(scope.inputs.configSha256, digest(await readFile(project.configPath)));
    assert.equal(scope.inputs.appBuildSha256, digest(project.appBytes));
    assert.equal(scope.inputs.walletArtifactSha256, MANAGED_WALLET_SHA256);
    assert.deepEqual(scope.inputs.flows.map((flow: Record<string, unknown>) => flow.kind), [
      "mwa-authorize",
      "mwa-siws",
      "mwa-sign-message",
      "mwa-reject",
    ]);
    for (const flow of scope.inputs.flows as Array<Record<string, string>>) {
      const scenarioId = flow.scenarioId;
      assert.ok(scenarioId);
      assert.equal(flow.fileSha256, digest(project.flowBytes[scenarioId]!));
    }
    assert.deepEqual(scope.policy.sharing, {
      publicEvidenceJson: false,
      sanitizedReports: false,
      publisherName: false,
      publisherLogo: false,
      approvedQuote: false,
      confirmedDefectRecord: false,
    });
    assert.equal(scope.policy.attendedExecutionRequired, true);
    assert.equal(scope.policy.manualWalletActionsRequired, true);
    assert.equal(scope.policy.valuableAssetsAllowed, false);
    for (const [type, value] of [
      ["scope", scope.scopeRef],
      ["operator", scope.operatorRef],
      ["pilot", scope.pilotRef],
      ["device", scope.deviceRef],
    ] as const) {
      assert.match(value, new RegExp("^urn:launchrig:" + type + ":[a-f0-9-]{36}$"));
    }
    const metadata = await lstat(prepareOptions.outputPath);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.nlink, 1);
    if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o600);
    await assert.rejects(() => lstat(path.join(directory, ".launchrig")));

    const serializedResult = JSON.stringify(result);
    assert.doesNotMatch(serializedResult, /private-scope|urn:launchrig:|123e4567|com\.publisher/);
    const schema = JSON.parse(
      await readFile(
        path.join(process.cwd(), "schemas", "launchrig-pilot-session-scope-draft-result.schema.json"),
        "utf8",
      ),
    );
    const validate = new Ajv2020({ strict: true }).compile(schema);
    assert.equal(validate(result), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...result, grantReady: true }), false);
    assert.equal(validate({ ...result, outputPath: prepareOptions.outputPath }), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepare-scope CLI is path-free and rejects device-facing options", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "launchrig-prepare-scope-cli-")));
  try {
    const project = await writePublisherProject(directory);
    for (const json of [false, true]) {
      const outputPath = path.join(directory, json ? "json-private-canary.json" : "human-private-canary.json");
      const output: string[] = [];
      const errors: string[] = [];
      const exitCode = await runCli(
        [
          "pilot",
          "prepare-scope",
          "--config",
          project.configPath,
          "--bundle",
          verifiedBundleDirectory,
          "--expires-on",
          "2099-12-31",
          "--deletion-method",
          "publisher-managed",
          "--output",
          outputPath,
          ...(json ? ["--json"] : []),
        ],
        { out: (message) => output.push(message), error: (message) => errors.push(message) },
      );
      assert.equal(exitCode, 0);
      assert.equal(errors.length, 0);
      const rendered = output.join("\n");
      assert.doesNotMatch(rendered, /private-canary|urn:launchrig:|123e4567|com\.publisher/);
      assert.match(rendered, json ? /"reviewRequired": true/ : /human review required: yes/);
    }

    const errors: string[] = [];
    const rejected = await runCli(
      [
        "pilot",
        "prepare-scope",
        "--config",
        project.configPath,
        "--bundle",
        verifiedBundleDirectory,
        "--expires-on",
        "2099-12-31",
        "--deletion-method",
        "publisher-managed",
        "--output",
        path.join(directory, "rejected.json"),
        "--device=PHONE-SERIAL-CANARY",
      ],
      { out: () => undefined, error: (message) => errors.push(message) },
    );
    assert.equal(rejected, 2);
    assert.match(errors.join("\n"), /pilot prepare-scope does not accept --device/);
    assert.doesNotMatch(errors.join("\n"), /PHONE-SERIAL-CANARY/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepare-scope fails closed on bundle tampering and unsafe output", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "launchrig-prepare-scope-races-")));
  try {
    const project = await writePublisherProject(directory);
    const tamperedBundle = path.join(directory, "tampered-bundle");
    await cp(verifiedBundleDirectory, tamperedBundle, { recursive: true, errorOnExist: true });
    await writeFile(path.join(tamperedBundle, "README.md"), "tampered bundle guidance\n", "utf8");
    const mutationOutput = path.join(directory, "bundle-mutation.json");
    await assert.rejects(
      () =>
        preparePilotSessionScope({
          ...options(directory, project.configPath, "bundle-mutation.json"),
          bundleDirectory: tamperedBundle,
        }),
      (error: unknown) => error instanceof PilotSessionScopeError && error.exitCode === 3,
    );
    await assert.rejects(() => lstat(mutationOutput));

    await assert.rejects(
      () =>
        preparePilotSessionScope({
          ...options(directory, project.configPath),
          outputPath: "relative-private-scope.json",
        }),
      /must be absolute/,
    );
    const existingOutput = path.join(directory, "existing.json");
    await writeFile(existingOutput, "existing\n", { mode: 0o600 });
    await assert.rejects(
      () => preparePilotSessionScope(options(directory, project.configPath, "existing.json")),
      (error: unknown) => error instanceof PilotSessionScopeError && error.exitCode === 2,
    );
    assert.equal(await readFile(existingOutput, "utf8"), "existing\n");

    await assert.rejects(
      () =>
        preparePilotSessionScope({
          ...options(directory, project.configPath),
          outputPath: path.join(verifiedBundleDirectory, "inside-bundle.json"),
        }),
      /must be outside the publisher bundle/,
    );
    const privateDirectory = path.join(directory, "private-directory");
    const linkedDirectory = path.join(directory, "linked-private-directory");
    await mkdir(privateDirectory);
    await symlink(privateDirectory, linkedDirectory);
    await assert.rejects(
      () =>
        preparePilotSessionScope({
          ...options(directory, project.configPath),
          outputPath: path.join(linkedDirectory, "scope.json"),
        }),
      (error: unknown) => error instanceof PilotSessionScopeError && error.exitCode === 3,
    );
    await assert.rejects(() => lstat(path.join(privateDirectory, "scope.json")));

    const realAncestor = path.join(directory, "real-ancestor");
    const linkedAncestor = path.join(directory, "linked-ancestor");
    const nestedParent = path.join(realAncestor, "nested-private-directory");
    await mkdir(nestedParent, { recursive: true });
    await symlink(realAncestor, linkedAncestor);
    await assert.rejects(
      () =>
        preparePilotSessionScope({
          ...options(directory, project.configPath),
          outputPath: path.join(linkedAncestor, "nested-private-directory", "scope.json"),
        }),
      (error: unknown) => error instanceof PilotSessionScopeError && error.exitCode === 3,
    );
    await assert.rejects(() => lstat(path.join(nestedParent, "scope.json")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepare-scope rejects an unrecognized configured wallet APK and an extra flow", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "launchrig-prepare-scope-policy-")));
  try {
    const project = await writePublisherProject(directory);
    await writeFile(path.join(directory, "wallet.apk"), "unrecognized wallet apk\n");
    const source = await readFile(project.configPath, "utf8");
    await writeFile(
      project.configPath,
      source.replace("  packageName: com.solana.mwallet\n  install: false", "  packageName: com.solana.mwallet\n  apk: ./wallet.apk\n  install: false"),
      "utf8",
    );
    await assert.rejects(
      () => preparePilotSessionScope(options(directory, project.configPath)),
      /does not match the managed artifact digest/,
    );

    await writeFile(project.configPath, source, "utf8");
    await writeFile(
      path.join(directory, "extra.yaml"),
      "appId: com.publisher.launchrig\n---\n- assertVisible:\n    id: extra-ready\n",
      "utf8",
    );
    await writeFile(
      project.configPath,
      source.replace(
        "artifacts:",
        [
          "  - id: extra",
          "    kind: custom",
          "    name: extra",
          "    flow: ./extra.yaml",
          "    required: false",
          "artifacts:",
        ].join("\n"),
      ),
      "utf8",
    );
    await assert.rejects(
      () => preparePilotSessionScope(options(directory, project.configPath, "extra.json")),
      /exactly four required core MWA scenarios/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
