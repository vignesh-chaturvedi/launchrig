import { cp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyYamlRuntimeDirectory,
  YAML_RUNTIME_LICENSE,
  YAML_RUNTIME_NAME,
  YAML_RUNTIME_VERSION,
} from "./runtime-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await realpath(path.join(root, "node_modules", "yaml"));
const metadata = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
if (
  metadata.name !== YAML_RUNTIME_NAME ||
  metadata.version !== YAML_RUNTIME_VERSION ||
  metadata.license !== YAML_RUNTIME_LICENSE
) {
  throw new Error("The installed YAML runtime does not match the pinned vendoring contract.");
}
await verifyYamlRuntimeDirectory(source);

const target = path.join(root, "dist", "node_modules", "yaml");
await rm(target, { recursive: true, force: true });
await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
await verifyYamlRuntimeDirectory(target);
