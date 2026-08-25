import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { runProcess, type ProcessOptions, type ProcessResult } from "../utils/process.js";

export type MaestroRunner = (command: string, args: string[], options?: ProcessOptions) => Promise<ProcessResult>;

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
    env?: NodeJS.ProcessEnv;
  }): Promise<ProcessResult> {
    await mkdir(input.outputDirectory, { recursive: true });
    const junitPath = path.join(input.outputDirectory, "maestro-junit.xml");
    const debugDirectory = path.join(input.outputDirectory, "maestro-artifacts");
    await mkdir(debugDirectory, { recursive: true });
    try {
      return await this.runner(
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
    } finally {
      await rm(debugDirectory, { recursive: true, force: true });
    }
  }
}
