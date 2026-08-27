import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LaunchRigReport } from "../types.js";
import { redactJsonValue } from "../security/redact.js";
import { renderHtml, renderJunit } from "./render.js";

export interface WrittenArtifacts {
  directory: string;
  json: string;
  html: string;
  junit: string;
  redactionCount: number;
}

export async function writeReportArtifacts(
  report: LaunchRigReport,
  directory: string,
  customPatterns: string[] = [],
): Promise<WrittenArtifacts> {
  const redacted = redactJsonValue(report, customPatterns);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const jsonPath = path.join(directory, "launchrig-report.json");
  const htmlPath = path.join(directory, "launchrig-report.html");
  const junitPath = path.join(directory, "launchrig-junit.xml");
  await Promise.all([
    writeFile(jsonPath, JSON.stringify(redacted.value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 }),
    writeFile(htmlPath, renderHtml(redacted.value), { encoding: "utf8", mode: 0o600 }),
    writeFile(junitPath, renderJunit(redacted.value), { encoding: "utf8", mode: 0o600 }),
  ]);
  return {
    directory,
    json: jsonPath,
    html: htmlPath,
    junit: junitPath,
    redactionCount: redacted.count,
  };
}
