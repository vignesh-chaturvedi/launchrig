import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizeMaestroJunit } from "../security/maestro.js";
import { runProcess, type ProcessOptions, type ProcessResult } from "../utils/process.js";

export type MaestroRunner = (command: string, args: string[], options?: ProcessOptions) => Promise<ProcessResult>;

const MAESTRO_ENV_ALLOWLIST = [
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "CI",
  "ComSpec",
  "HOME",
  "JAVA_HOME",
  "LANG",
  "LC_ALL",
  "MAESTRO_HOME",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
] as const;

export function minimalMaestroEnvironment(env: NodeJS.ProcessEnv, adbDirectory: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: adbDirectory + path.delimiter + (env.PATH ?? ""),
    MAESTRO_CLI_NO_ANALYTICS: "true",
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true",
  };
  for (const key of MAESTRO_ENV_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export class MaestroClient {
  constructor(
    readonly binary: string,
    private readonly runner: MaestroRunner = runProcess,
  ) {}

  async version(env: NodeJS.ProcessEnv = process.env): Promise<ProcessResult> {
    return await this.runner(this.binary, ["--version"], {
      timeoutMs: 30000,
      env: {
        ...env,
        MAESTRO_CLI_NO_ANALYTICS: "true",
        MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true",
      },
    });
  }

  async runFlow(input: {
    serial: string;
    flowPath: string;
    outputDirectory: string;
    timeoutMs: number;
    redactPatterns?: string[];
    env?: NodeJS.ProcessEnv;
  }): Promise<ProcessResult> {
    await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });
    const rawDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrig-maestro-"));
    await chmod(rawDirectory, 0o700);
    const junitPath = path.join(rawDirectory, "maestro-junit.xml");
    const debugDirectory = path.join(rawDirectory, "maestro-artifacts");
    await mkdir(debugDirectory, { mode: 0o700 });
    try {
      const execution = await this.runner(
        this.binary,
        [
          "--device=" + input.serial,
          "test",
          "--format",
          "junit",
          "--output",
          junitPath,
          "--test-output-dir",
          debugDirectory,
          input.flowPath,
        ],
        {
          timeoutMs: input.timeoutMs,
          maxOutputBytes: 1024 * 1024,
          env: {
            ...(input.env ?? process.env),
            MAESTRO_CLI_NO_ANALYTICS: "true",
            MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true",
          },
        },
      );
      try {
        const rawJunit = await readFile(junitPath, "utf8");
        await writeFile(
          path.join(input.outputDirectory, "maestro-junit.xml"),
          sanitizeMaestroJunit(rawJunit, input.serial, input.redactPatterns ?? []),
          { encoding: "utf8", mode: 0o600 },
        );
      } catch {
        // Maestro can exit before writing JUnit; stdout and stderr still describe the failure.
      }
      return execution;
    } finally {
      await rm(rawDirectory, { recursive: true, force: true });
    }
  }
}
