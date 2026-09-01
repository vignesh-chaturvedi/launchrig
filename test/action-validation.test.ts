import assert from "node:assert/strict";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";

interface CommandExecution {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimited: boolean;
}

interface ActionPaths {
  workspace: string;
  workingDirectory: string;
  configPath: string;
  outputPath: string;
  configFile: string;
  resultFile: string;
}

interface ActionResult {
  schemaVersion: number;
  kind: string;
  status: "passed" | "failed" | "error";
  valid: boolean;
  configFile: string;
  resultFile: string;
  scenarioCount: number | null;
  validation: null | {
    schemaVersion: 1;
    kind: "launchrig-config-validation-result";
    profile: "config-rules-v1";
    status: "pre-award-foundation";
    project: string | null;
    packageName: string | null;
    scenarios: number | null;
    issues: string[];
    diagnostics: Array<{
      ruleId: string;
      checkId: string;
      code: string;
      path: string;
      message: string;
    }>;
    ruleResults: Array<{
      ruleId: string;
      checkId: string;
      status: "passed" | "failed" | "not-evaluated";
      diagnosticCount: number;
    }>;
    grantMilestoneComplete: false;
  };
  failureCode: string | null;
}

interface ActionModule {
  assertSupportedNodeVersion(version: string): void;
  executeLaunchRig(input: {
    cliPath: string;
    workingDirectory: string;
    configPath: string;
    environment?: Record<string, string | undefined>;
    timeoutMs?: number;
    maximumOutputBytes?: number;
  }): Promise<CommandExecution>;
  resolveActionPaths(environment: Record<string, string | undefined>): Promise<ActionPaths>;
  resolveLaunchRigCli(workingDirectory: string, environment?: Record<string, string | undefined>): Promise<string>;
  runValidationAction(
    environment: Record<string, string | undefined>,
    dependencies?: {
      nodeVersion?: string;
      resolveLaunchRigCli?: (workingDirectory: string) => Promise<string>;
      executeLaunchRig?: (input: {
        cliPath: string;
        workingDirectory: string;
        configPath: string;
        environment: Record<string, string | undefined>;
      }) => Promise<CommandExecution>;
    },
  ): Promise<{ exitCode: number; result: ActionResult }>;
}

const actionModule = (await import(
  pathToFileURL(path.join(process.cwd(), "action", "run-validation.mjs")).href
)) as ActionModule;

async function createWorkspace() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "launchrig-action-"));
  const workingDirectory = path.join(workspace, "app folder=one");
  await mkdir(workingDirectory);
  const configName = "launchrig;literal.yml";
  const configPath = path.join(workingDirectory, configName);
  await writeFile(configPath, "version: 1\n", "utf8");
  const githubOutput = path.join(workspace, "github-output.txt");
  await writeFile(githubOutput, "", "utf8");
  const environment: Record<string, string | undefined> = {
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: githubOutput,
    LAUNCHRIG_ACTION_WORKING_DIRECTORY: "app folder=one",
    LAUNCHRIG_ACTION_CONFIG: configName,
    LAUNCHRIG_ACTION_OUTPUT: ".launchrig/reports=ci/result file.json",
  };
  return { workspace, workingDirectory, configPath, githubOutput, environment };
}

function execution(value: Record<string, unknown>, exitCode = 0): CommandExecution {
  return {
    exitCode,
    signal: null,
    stdout: JSON.stringify(value),
    stderr: "",
    timedOut: false,
    outputLimited: false,
  };
}

function validation(configPath: string, valid = true) {
  const rules = [
    ["LR001", "config.schema"],
    ["LR002", "config.network-safety"],
    ["LR003", "config.wallet-safety"],
    ["LR004", "config.privacy-safety"],
    ["LR005", "config.input-files"],
  ] as const;
  const diagnostics = valid
    ? []
    : [
        {
          ruleId: "LR005",
          checkId: "config.input-files",
          code: "config.input-files.flow-unavailable",
          path: "scenarios[0].flow",
          message: "Scenario authorize flow cannot be read safely",
        },
      ];
  return {
    schemaVersion: 1,
    kind: "launchrig-config-validation-result",
    profile: "config-rules-v1",
    status: "pre-award-foundation",
    valid,
    configPath,
    project: "Action Fixture",
    packageName: "com.example.actionfixture",
    scenarios: 2,
    issues: diagnostics.map((entry) => entry.message),
    diagnostics,
    ruleResults: rules.map(([ruleId, checkId]) => ({
      ruleId,
      checkId,
      status: !valid && ruleId === "LR005" ? "failed" : "passed",
      diagnosticCount: !valid && ruleId === "LR005" ? 1 : 0,
    })),
    grantMilestoneComplete: false,
  };
}

function priorActionResult(configFile: string, resultFile: string): ActionResult {
  return {
    schemaVersion: 1,
    kind: "launchrig-validation-action-result",
    status: "passed",
    valid: true,
    configFile,
    resultFile,
    scenarioCount: 2,
    validation: {
      schemaVersion: 1,
      kind: "launchrig-config-validation-result",
      profile: "config-rules-v1",
      status: "pre-award-foundation",
      project: "Prior Action Fixture",
      packageName: "com.example.prioractionfixture",
      scenarios: 2,
      issues: [],
      diagnostics: [],
      ruleResults: ([
        ["LR001", "config.schema"],
        ["LR002", "config.network-safety"],
        ["LR003", "config.wallet-safety"],
        ["LR004", "config.privacy-safety"],
        ["LR005", "config.input-files"],
      ] as const).map(([ruleId, checkId]) => ({
        ruleId,
        checkId,
        status: "passed" as const,
        diagnosticCount: 0,
      })),
      grantMilestoneComplete: false,
    },
    failureCode: null,
  };
}

test("validation Action metadata is device-free and keeps inputs out of shell source", async () => {
  const metadataSource = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
  const metadata = parse(metadataSource) as Record<string, any>;
  assert.equal(metadata.name, "LaunchRig config validation");
  assert.deepEqual(Object.keys(metadata.inputs), ["config", "working-directory", "output"]);
  assert.deepEqual(Object.keys(metadata.outputs), ["valid", "scenario-count", "result-file"]);
  assert.equal(metadata.runs.using, "composite");
  assert.equal(metadata.runs.steps.length, 1);
  const step = metadata.runs.steps[0];
  assert.equal(step.id, "validate");
  assert.equal(step.shell, "bash");
  assert.equal(step.run, 'node "$GITHUB_ACTION_PATH/action/run-validation.mjs"');
  assert.equal(step.uses, undefined);
  assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./);
  assert.doesNotMatch(metadataSource, /\bADB serial\b|\bdevice:\s|\bcommand:\s|launchrig run/);

  const examplePath = path.join(process.cwd(), "examples", "github-actions", "launchrig-validation.yml");
  const exampleSource = await readFile(examplePath, "utf8");
  assert.match(exampleSource, /permissions:\n  contents: read/);
  assert.match(exampleSource, /YOUR_ORG\/launchrig@FULL_COMMIT_SHA/);
  assert.match(exampleSource, /actions\/checkout@[a-f0-9]{40}/);
  assert.match(exampleSource, /actions\/setup-node@[a-f0-9]{40}/);
  assert.match(exampleSource, /pnpm\/action-setup@[a-f0-9]{40}/);
  assert.match(exampleSource, /persist-credentials: false/);
  assert.match(exampleSource, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.doesNotMatch(exampleSource, /\bcorepack\b/);
  assert.doesNotMatch(examplePath, /\.github\/workflows/);

  const ciSource = await readFile(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
  const ci = parse(ciSource) as Record<string, any>;
  assert.deepEqual(ci.permissions, { contents: "read" });
  const verifySteps = ci.jobs.verify.steps as Array<Record<string, unknown>>;
  assert.ok(
    verifySteps.findIndex((step) => step.run === "pnpm fixtures:fetch") <
      verifySteps.findIndex((step) => step.uses === "./"),
  );
  for (const job of Object.values(ci.jobs) as Array<Record<string, any>>) {
    const checkout = job.steps.find((step: Record<string, any>) => step.uses === "actions/checkout@v4");
    assert.equal(checkout.with["persist-credentials"], false);
  }
});

test("Action paths accept literal spaces, equals signs, and shell metacharacters without escaping the workspace", async () => {
  const fixture = await createWorkspace();
  try {
    const paths = await actionModule.resolveActionPaths(fixture.environment);
    assert.equal(paths.workspace, await realpath(fixture.workspace));
    assert.equal(paths.workingDirectory, await realpath(fixture.workingDirectory));
    assert.equal(paths.configPath, await realpath(fixture.configPath));
    assert.equal(paths.configFile, "app folder=one/launchrig;literal.yml");
    assert.equal(paths.resultFile, "app folder=one/.launchrig/reports=ci/result file.json");
    assert.equal(
      paths.outputPath,
      path.join(await realpath(fixture.workingDirectory), ".launchrig", "reports=ci", "result file.json"),
    );
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("Action paths reject traversal, absolute paths, controls, and non-normalized segments", async (context) => {
  const fixture = await createWorkspace();
  try {
    for (const [key, value] of [
      ["LAUNCHRIG_ACTION_WORKING_DIRECTORY", "../escape"],
      ["LAUNCHRIG_ACTION_WORKING_DIRECTORY", "/tmp/escape"],
      ["LAUNCHRIG_ACTION_CONFIG", "../launchrig.yml"],
      ["LAUNCHRIG_ACTION_CONFIG", "C:/escape.yml"],
      ["LAUNCHRIG_ACTION_OUTPUT", "../result.json"],
      ["LAUNCHRIG_ACTION_OUTPUT", "./result.json"],
      ["LAUNCHRIG_ACTION_OUTPUT", "bad\nresult.json"],
      ["LAUNCHRIG_ACTION_OUTPUT", ".launchrig/result.txt"],
    ] as const) {
      await context.test(key + " rejects " + JSON.stringify(value), async () => {
        await assert.rejects(
          () => actionModule.resolveActionPaths({ ...fixture.environment, [key]: value }),
          /relative path|unsafe path segment|JSON file beneath/,
        );
      });
    }
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("Action paths reject symlink components and unsafe existing outputs", async (context) => {
  const fixture = await createWorkspace();
  try {
    const realDirectory = path.join(fixture.workspace, "real-directory");
    await mkdir(realDirectory);
    await writeFile(path.join(realDirectory, "launchrig.yml"), "version: 1\n", "utf8");
    await symlink(realDirectory, path.join(fixture.workspace, "linked-directory"), "dir");
    await context.test("workspace symlink", async () => {
      await assert.rejects(
        () =>
          actionModule.resolveActionPaths({
            ...fixture.environment,
            GITHUB_WORKSPACE: path.join(fixture.workspace, "linked-directory"),
            LAUNCHRIG_ACTION_WORKING_DIRECTORY: ".",
            LAUNCHRIG_ACTION_CONFIG: "launchrig.yml",
          }),
        /non-symlink directory/,
      );
    });
    await context.test("working directory symlink", async () => {
      await assert.rejects(
        () =>
          actionModule.resolveActionPaths({
            ...fixture.environment,
            LAUNCHRIG_ACTION_WORKING_DIRECTORY: "linked-directory",
            LAUNCHRIG_ACTION_CONFIG: "launchrig.yml",
          }),
        /symlink component/,
      );
    });

    const outputRoot = path.join(fixture.workingDirectory, ".launchrig");
    await mkdir(outputRoot, { recursive: true });
    const outputParentTarget = path.join(fixture.workspace, "output-parent-target");
    const linkedOutputParent = path.join(outputRoot, "linked-output-parent");
    await mkdir(outputParentTarget);
    await symlink(outputParentTarget, linkedOutputParent, "dir");
    await context.test("output parent symlink", async () => {
      await assert.rejects(
        () =>
          actionModule.resolveActionPaths({
            ...fixture.environment,
            LAUNCHRIG_ACTION_OUTPUT: ".launchrig/linked-output-parent/result.json",
          }),
        /symlink component/,
      );
    });

    const linkedConfig = path.join(fixture.workingDirectory, "linked.yml");
    await symlink(fixture.configPath, linkedConfig);
    await context.test("config symlink", async () => {
      await assert.rejects(
        () =>
          actionModule.resolveActionPaths({
            ...fixture.environment,
            LAUNCHRIG_ACTION_CONFIG: "linked.yml",
          }),
        /non-symlink regular file/,
      );
    });

    const outputTarget = path.join(outputRoot, "target.json");
    await writeFile(outputTarget, "{}\n", "utf8");
    const outputLink = path.join(outputRoot, "output-link.json");
    await symlink(outputTarget, outputLink);
    await context.test("output symlink", async () => {
      await assert.rejects(
        () =>
          actionModule.resolveActionPaths({
            ...fixture.environment,
            LAUNCHRIG_ACTION_OUTPUT: ".launchrig/output-link.json",
          }),
        /existing non-symlink LaunchRig result file/,
      );
    });

    const outputDirectory = path.join(outputRoot, "output-directory.json");
    await mkdir(outputDirectory);
    await context.test("output directory", async () => {
      await assert.rejects(
        () =>
          actionModule.resolveActionPaths({
            ...fixture.environment,
            LAUNCHRIG_ACTION_OUTPUT: ".launchrig/output-directory.json",
          }),
        /existing non-symlink LaunchRig result file/,
      );
    });
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("Action output cannot replace config, package metadata, or non-result files", async () => {
  const fixture = await createWorkspace();
  try {
    for (const output of ["launchrig;literal.yml", "package.json", ".git/config"]) {
      await assert.rejects(
        () =>
          actionModule.resolveActionPaths({
            ...fixture.environment,
            LAUNCHRIG_ACTION_OUTPUT: output,
          }),
        /JSON file beneath/,
      );
    }

    const outputRoot = path.join(fixture.workingDirectory, ".launchrig");
    await mkdir(outputRoot, { recursive: true });
    const protectedFiles = [
      ["package.json", '{"name":"protected-package"}\n'],
      ["source.json", '{"source":"protected"}\n'],
    ] as const;
    for (const [name, source] of protectedFiles) {
      const protectedPath = path.join(outputRoot, name);
      await writeFile(protectedPath, source, "utf8");
      await assert.rejects(
        () =>
          actionModule.resolveActionPaths({
            ...fixture.environment,
            LAUNCHRIG_ACTION_OUTPUT: ".launchrig/" + name,
          }),
        /not a LaunchRig validation Action result/,
      );
      assert.equal(await readFile(protectedPath, "utf8"), source);
    }
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("Action runner writes one normalized private result and safe outputs for a valid config", async () => {
  const fixture = await createWorkspace();
  try {
    let invocation:
      | { cliPath: string; workingDirectory: string; configPath: string; environment: Record<string, string | undefined> }
      | undefined;
    const outcome = await actionModule.runValidationAction(fixture.environment, {
      resolveLaunchRigCli: async () => "/fixed/launchrig-cli.js",
      executeLaunchRig: async (input) => {
        invocation = input;
        return execution(validation(input.configPath));
      },
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.result.status, "passed");
    assert.equal(outcome.result.failureCode, null);
    assert.equal(outcome.result.scenarioCount, 2);
    assert.equal(invocation?.cliPath, "/fixed/launchrig-cli.js");
    assert.equal(invocation?.workingDirectory, await realpath(fixture.workingDirectory));
    const resultPath = path.join(fixture.workingDirectory, ".launchrig", "reports=ci", "result file.json");
    const result = JSON.parse(await readFile(resultPath, "utf8")) as ActionResult;
    assert.deepEqual(result, outcome.result);
    assert.equal((await lstat(resultPath)).mode & 0o777, 0o600);
    assert.equal(
      await readFile(fixture.githubOutput, "utf8"),
      "valid=true\nscenario-count=2\nresult-file=app folder=one/.launchrig/reports=ci/result file.json\n",
    );
    assert.deepEqual(await readdir(path.dirname(resultPath)), ["result file.json"]);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("Action runner preserves structured invalid results and then fails the step", async () => {
  const fixture = await createWorkspace();
  try {
    const resultPath = path.join(fixture.workingDirectory, ".launchrig", "reports=ci", "result file.json");
    await mkdir(path.dirname(resultPath), { recursive: true });
    await writeFile(
      resultPath,
      JSON.stringify(
        priorActionResult(
          "app folder=one/launchrig;literal.yml",
          "app folder=one/.launchrig/reports=ci/result file.json",
        ),
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const outcome = await actionModule.runValidationAction(fixture.environment, {
      resolveLaunchRigCli: async () => "/fixed/launchrig-cli.js",
      executeLaunchRig: async (input) => execution(validation(input.configPath, false), 2),
    });
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.result.status, "failed");
    assert.equal(outcome.result.failureCode, "configuration-invalid");
    assert.deepEqual(outcome.result.validation?.issues, [
      "Scenario authorize flow cannot be read safely",
    ]);
    assert.equal(outcome.result.validation?.diagnostics[0]?.ruleId, "LR005");
    assert.equal(outcome.result.validation?.ruleResults[4]?.status, "failed");
    assert.equal(outcome.result.validation?.grantMilestoneComplete, false);
    assert.equal(
      await readFile(fixture.githubOutput, "utf8"),
      "valid=false\nscenario-count=2\nresult-file=app folder=one/.launchrig/reports=ci/result file.json\n",
    );
    assert.equal(JSON.parse(await readFile(resultPath, "utf8")).failureCode, "configuration-invalid");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("Action runner fails closed for malformed, contradictory, and failed command results", async (context) => {
  const cases: Array<[string, (configPath: string) => Promise<CommandExecution>, string]> = [
    [
      "missing JSON",
      async () => ({ ...execution({}, 2), stdout: "", stderr: "private parser detail" }),
      "invalid-command-output",
    ],
    ["contradictory exit", async (configPath) => execution(validation(configPath), 2), "invalid-command-output"],
    [
      "invalid result without issues",
      async (configPath) => execution({ ...validation(configPath, false), issues: [] }, 2),
      "invalid-command-output",
    ],
    ["unsupported exit", async () => execution({}, 4), "command-exit"],
    ["executor error", async () => { throw new Error("private child error"); }, "validation-command-error"],
  ];
  for (const [name, executeLaunchRig, expectedCode] of cases) {
    await context.test(name, async () => {
      const fixture = await createWorkspace();
      try {
        const outcome = await actionModule.runValidationAction(fixture.environment, {
          resolveLaunchRigCli: async () => "/fixed/launchrig-cli.js",
          executeLaunchRig: async (input) => await executeLaunchRig(input.configPath),
        });
        assert.equal(outcome.exitCode, 1);
        assert.equal(outcome.result.status, "error");
        assert.equal(outcome.result.failureCode, expectedCode);
        assert.equal(outcome.result.validation, null);
        const resultSource = await readFile(
          path.join(fixture.workingDirectory, ".launchrig", "reports=ci", "result file.json"),
          "utf8",
        );
        assert.doesNotMatch(resultSource, /private parser detail|private child error/);
      } finally {
        await rm(fixture.workspace, { recursive: true, force: true });
      }
    });
  }
});

test("production executor passes exact arguments without a shell and removes caller secrets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-action-exec-"));
  try {
    const marker = path.join(directory, "marker-created-by-shell");
    const configPath = path.join(directory, "config;touch marker-created-by-shell.yml");
    await writeFile(configPath, "version: 1\n", "utf8");
    const cliPath = path.join(directory, "fake-cli.mjs");
    await writeFile(
      cliPath,
      [
        "const args = process.argv.slice(2);",
        "process.stdout.write(JSON.stringify({ args, secret: process.env.ACTION_TEST_SECRET ?? null }));",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(cliPath, 0o700);
    const result = await actionModule.executeLaunchRig({
      cliPath,
      workingDirectory: directory,
      configPath,
      environment: { ...process.env, ACTION_TEST_SECRET: "must-not-reach-child" },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    const output = JSON.parse(result.stdout) as { args: string[]; secret: string | null };
    assert.deepEqual(output.args, ["validate", "--config", configPath, "--json"]);
    assert.equal(output.secret, null);
    await assert.rejects(() => lstat(marker), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production executor bounds time and combined output", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-action-bounds-"));
  try {
    const configPath = path.join(directory, "launchrig.yml");
    await writeFile(configPath, "version: 1\n", "utf8");
    await context.test("timeout", async () => {
      const cliPath = path.join(directory, "slow.mjs");
      await writeFile(cliPath, "setTimeout(() => {}, 5000);\n", "utf8");
      const result = await actionModule.executeLaunchRig({
        cliPath,
        workingDirectory: directory,
        configPath,
        timeoutMs: 40,
      });
      assert.equal(result.timedOut, true);
      assert.notEqual(result.signal, null);
    });
    await context.test("output limit", async () => {
      const cliPath = path.join(directory, "loud.mjs");
      await writeFile(cliPath, 'process.stdout.write("x".repeat(4096));\n', "utf8");
      const result = await actionModule.executeLaunchRig({
        cliPath,
        workingDirectory: directory,
        configPath,
        maximumOutputBytes: 128,
      });
      assert.equal(result.outputLimited, true);
      assert.notEqual(result.signal, null);
    });
    await context.test("invalid UTF-8", async () => {
      const cliPath = path.join(directory, "invalid-utf8.mjs");
      await writeFile(cliPath, "process.stdout.write(Buffer.from([255]));\n", "utf8");
      await assert.rejects(
        () =>
          actionModule.executeLaunchRig({
            cliPath,
            workingDirectory: directory,
            configPath,
          }),
        /not valid UTF-8/,
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Action resolves only a bounded versioned LaunchRig package CLI", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-action-package-"));
  try {
    const distDirectory = path.join(directory, "dist", "src");
    await mkdir(distDirectory, { recursive: true });
    const cliPath = path.join(distDirectory, "cli.js");
    await writeFile(cliPath, "console.log('fixture');\n", "utf8");
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "launchrig", version: "0.1.0", bin: { launchrig: "dist/src/cli.js" } }) + "\n",
      "utf8",
    );
    assert.equal(
      await actionModule.resolveLaunchRigCli(directory, { GITHUB_ACTION_PATH: directory }),
      await realpath(cliPath),
    );

    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "launchrig", version: "0.1.0", bin: { launchrig: "../outside.js" } }) + "\n",
      "utf8",
    );
    await assert.rejects(
      () => actionModule.resolveLaunchRigCli(directory, { GITHUB_ACTION_PATH: directory }),
      /unsafe CLI path|Install a versioned LaunchRig package/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Action source without dist resolves and runs the caller's installed LaunchRig package", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "launchrig-action-consumer-"));
  try {
    const actionSource = path.join(workspace, "action-source");
    const consumer = path.join(workspace, "consumer");
    const installedPackage = path.join(consumer, "node_modules", "launchrig");
    await mkdir(actionSource, { recursive: true });
    await mkdir(path.join(installedPackage, "dist"), { recursive: true });
    await writeFile(
      path.join(actionSource, "package.json"),
      JSON.stringify({ name: "launchrig", version: "0.1.0", bin: { launchrig: "dist/src/cli.js" } }) + "\n",
      "utf8",
    );
    await writeFile(
      path.join(installedPackage, "package.json"),
      JSON.stringify({ name: "launchrig", version: "0.1.0", type: "module", bin: { launchrig: "dist/src/cli.js" } }) +
        "\n",
      "utf8",
    );
    await cp(path.join(process.cwd(), "dist", "src"), path.join(installedPackage, "dist", "src"), {
      recursive: true,
    });
    await cp(
      path.join(process.cwd(), "dist", "node_modules"),
      path.join(installedPackage, "dist", "node_modules"),
      { recursive: true },
    );

    const projectName = "P".repeat(512);
    const packageName = "com.example." + "a".repeat(256);
    await writeFile(
      path.join(consumer, "launchrig.yml"),
      stringify({
        version: 1,
        project: { name: projectName, packageName, install: false },
        target: { network: "devnet" },
        device: { requirePhysical: true, minimumApiLevel: 26 },
        wallet: { mode: "mock-mwa", packageName: "com.solana.mwallet", install: false },
        scenarios: [],
        artifacts: { directory: "./.launchrig/results", screenshots: "failure", retention: 5 },
        privacy: { includeLogcat: false, logcatLines: 200, redactPatterns: [] },
        tooling: {},
      }),
      "utf8",
    );
    const githubOutput = path.join(workspace, "github-output.txt");
    await writeFile(githubOutput, "", "utf8");
    const outcome = await actionModule.runValidationAction({
      GITHUB_ACTION_PATH: actionSource,
      GITHUB_OUTPUT: githubOutput,
      GITHUB_WORKSPACE: workspace,
      LAUNCHRIG_ACTION_WORKING_DIRECTORY: "consumer",
      LAUNCHRIG_ACTION_CONFIG: "launchrig.yml",
      LAUNCHRIG_ACTION_OUTPUT: ".launchrig/consumer-validation.json",
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.result.valid, true);
    assert.equal(outcome.result.validation?.project, projectName);
    assert.equal(outcome.result.validation?.packageName, packageName);
    assert.equal(outcome.result.scenarioCount, 0);
    assert.equal(
      await readFile(githubOutput, "utf8"),
      "valid=true\nscenario-count=0\nresult-file=consumer/.launchrig/consumer-validation.json\n",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Action enforces the LaunchRig Node.js floor", () => {
  actionModule.assertSupportedNodeVersion("20.11.0");
  actionModule.assertSupportedNodeVersion("24.3.1");
  assert.throws(() => actionModule.assertSupportedNodeVersion("20.10.9"), /20.11 or newer/);
  assert.throws(() => actionModule.assertSupportedNodeVersion("19.99.0"), /20.11 or newer/);
  assert.throws(() => actionModule.assertSupportedNodeVersion("unknown"), /determine the Node.js version/);
});

test("Action refuses a symlinked GitHub output file", async () => {
  const fixture = await createWorkspace();
  try {
    const actualOutput = path.join(fixture.workspace, "actual-output.txt");
    const linkedOutput = path.join(fixture.workspace, "linked-output.txt");
    await writeFile(actualOutput, "", "utf8");
    await symlink(actualOutput, linkedOutput);
    await assert.rejects(
      () =>
        actionModule.runValidationAction(
          { ...fixture.environment, GITHUB_OUTPUT: linkedOutput },
          {
            resolveLaunchRigCli: async () => "/fixed/launchrig-cli.js",
            executeLaunchRig: async (input) => execution(validation(input.configPath)),
          },
        ),
      /existing bounded non-symlink file/,
    );
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});
