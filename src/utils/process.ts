import { spawn } from "node:child_process";

export interface ProcessResult {
  command: string;
  args: string[];
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
}

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class ProcessLaunchError extends Error {
  constructor(command: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super("Unable to start " + command + ": " + message);
    this.name = "ProcessLaunchError";
  }
}

export async function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeoutMs);
    timer.unref();

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= maxOutputBytes) target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));

    child.once("error", (error) => {
      finished = true;
      clearTimeout(timer);
      reject(new ProcessLaunchError(command, error));
    });

    child.once("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const timedOut = Date.now() - startedAt >= timeoutMs && signal !== null;
      const timeoutMessage = timedOut ? Buffer.from("\nProcess timed out after " + timeoutMs + "ms") : Buffer.alloc(0);
      const limitMessage =
        outputBytes > maxOutputBytes ? Buffer.from("\nOutput truncated at " + maxOutputBytes + " bytes") : Buffer.alloc(0);
      resolve({
        command,
        args: [...args],
        exitCode: code ?? (timedOut ? 124 : 1),
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat([...stderr, timeoutMessage, limitMessage]),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
