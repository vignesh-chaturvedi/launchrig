import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const resultsRoot = path.resolve(process.argv[2] ?? ".launchrig/results");
let removedDebugDirectories = 0;
let sanitizedJunitFiles = 0;

function maskIdentifier(value) {
  if (!value) return "unknown";
  return value.length <= 4 ? "***" : "***" + value.slice(-4);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "maestro-artifacts") {
        await rm(target, { recursive: true, force: true });
        removedDebugDirectories += 1;
      } else {
        await walk(target);
      }
      continue;
    }
    if (entry.isFile() && entry.name === "maestro-junit.xml") {
      const source = await readFile(target, "utf8");
      const sanitized = source.replace(
        /(\bdevice=)(["'])([^"']*)(\2)/g,
        (_match, prefix, quote, value) => prefix + quote + maskIdentifier(value) + quote,
      );
      if (sanitized !== source) {
        await writeFile(target, sanitized, "utf8");
        sanitizedJunitFiles += 1;
      }
    }
  }
}

await walk(resultsRoot);
console.log(
  JSON.stringify({ resultsRoot, removedDebugDirectories, sanitizedJunitFiles }, null, 2),
);
