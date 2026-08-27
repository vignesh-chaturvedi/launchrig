import { isAlias, parseAllDocuments, visit } from "yaml";

const SAFE_COMMANDS = new Set([
  "assertNotVisible",
  "assertVisible",
  "back",
  "doubleTapOn",
  "eraseText",
  "extendedWaitUntil",
  "hideKeyboard",
  "inputText",
  "launchApp",
  "longPressOn",
  "repeat",
  "retry",
  "runFlow",
  "scroll",
  "scrollUntilVisible",
  "stopApp",
  "swipe",
  "tapOn",
  "waitForAnimationToEnd",
]);

const STRING_COMMANDS = new Set([
  "back",
  "hideKeyboard",
  "launchApp",
  "scroll",
  "stopApp",
  "waitForAnimationToEnd",
]);

const PILOT_SELECTOR_COMMANDS = new Set([
  "assertNotVisible",
  "assertVisible",
  "doubleTapOn",
  "longPressOn",
  "tapOn",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function containsInterpolation(value: unknown): boolean {
  if (typeof value === "string") return value.includes("${");
  if (Array.isArray(value)) return value.some(containsInterpolation);
  return isRecord(value) && Object.values(value).some(containsInterpolation);
}

function containsReservedPilotSelector(value: unknown): boolean {
  if (typeof value === "string") return value.trim().startsWith("TODO:");
  if (Array.isArray(value)) return value.some(containsReservedPilotSelector);
  return isRecord(value) && Object.values(value).some(containsReservedPilotSelector);
}

function inspectPilotCondition(value: unknown, issues: Set<string>): void {
  if (!isRecord(value)) return;
  if (containsReservedPilotSelector(value.visible) || containsReservedPilotSelector(value.notVisible)) {
    issues.add("flow contains a reserved TODO: selector");
  }
}

function inspectPilotCommands(commands: unknown[], issues: Set<string>): void {
  for (const entry of commands) {
    if (!isRecord(entry)) continue;
    const command = Object.keys(entry)[0];
    if (!command) continue;
    const value = entry[command];
    if (PILOT_SELECTOR_COMMANDS.has(command) && containsReservedPilotSelector(value)) {
      issues.add("flow contains a reserved TODO: selector");
    }
    if (
      command === "scrollUntilVisible" &&
      isRecord(value) &&
      containsReservedPilotSelector(value.element)
    ) {
      issues.add("flow contains a reserved TODO: selector");
    }
    if (command === "extendedWaitUntil" && isRecord(value)) {
      if (containsReservedPilotSelector(value.visible) || containsReservedPilotSelector(value.notVisible)) {
        issues.add("flow contains a reserved TODO: selector");
      }
    }
    if ((command === "runFlow" || command === "repeat" || command === "retry") && isRecord(value)) {
      inspectPilotCondition(value.when, issues);
      if (command === "repeat") inspectPilotCondition(value.while, issues);
      if (Array.isArray(value.commands)) inspectPilotCommands(value.commands, issues);
    }
  }
}

function inspectNestedCommands(value: unknown, command: string, expectedAppId: string, issues: Set<string>): void {
  if (!isRecord(value) || !Array.isArray(value.commands) || "file" in value || "env" in value) {
    issues.add(command + " must use an inline commands list without file or env fields");
    return;
  }
  inspectCommands(value.commands, expectedAppId, issues);
}

function inspectLaunchApp(value: unknown, expectedAppId: string, issues: Set<string>): void {
  if (value === null || value === undefined || value === false || value === true) return;
  if (typeof value === "string") {
    if (value !== expectedAppId) issues.add("launchApp must target the configured project package");
    return;
  }
  if (!isRecord(value)) {
    issues.add("launchApp has an invalid value");
    return;
  }
  const allowedKeys = new Set(["appId", "clearKeychain", "clearState", "stopApp"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    issues.add("launchApp contains an option outside the LaunchRig policy allowlist");
  }
  if (value.appId !== undefined && value.appId !== expectedAppId) {
    issues.add("launchApp must target the configured project package");
  }
  if (value.clearState !== undefined && value.clearState !== false) {
    issues.add("flow must not clear application state");
  }
  if (value.clearKeychain !== undefined && value.clearKeychain !== false) {
    issues.add("flow must not clear a device keychain");
  }
  if (value.stopApp !== undefined && typeof value.stopApp !== "boolean") {
    issues.add("launchApp stopApp must be a boolean");
  }
}

function inspectStopApp(value: unknown, expectedAppId: string, issues: Set<string>): void {
  if (value === null || value === undefined || value === false || value === true) return;
  if (value !== expectedAppId) issues.add("stopApp must target the configured project package");
}

function inspectOpenLink(value: unknown, expectedAppId: string, issues: Set<string>): void {
  if (expectedAppId !== "dev.launchrig.fixture") {
    issues.add("openLink is reserved for the controlled LaunchRig fixture");
    return;
  }
  const link = typeof value === "string" ? value : isRecord(value) ? value.link : undefined;
  if (typeof link !== "string") {
    issues.add("controlled fixture openLink must contain a static link");
    return;
  }
  if (isRecord(value) && Object.keys(value).some((key) => key !== "link")) {
    issues.add("controlled fixture openLink may contain only the link field");
  }
  try {
    const parsed = new URL(link);
    if (parsed.protocol !== "launchrig:" || parsed.hostname !== "fixture" || parsed.username || parsed.password) {
      issues.add("controlled fixture openLink must use launchrig://fixture");
    }
  } catch {
    issues.add("controlled fixture openLink must be a valid static URI");
  }
}

function inspectCommands(commands: unknown[], expectedAppId: string, issues: Set<string>): void {
  for (const entry of commands) {
    if (typeof entry === "string") {
      if (!STRING_COMMANDS.has(entry)) issues.add("flow command is not in the LaunchRig policy allowlist: " + entry);
      continue;
    }
    if (!isRecord(entry)) {
      issues.add("flow commands must be strings or single-key objects");
      continue;
    }
    const keys = Object.keys(entry);
    if (keys.length !== 1) {
      issues.add("flow command objects must contain exactly one command");
      continue;
    }
    const command = keys[0] as string;
    const value = entry[command];
    if (command === "openLink") {
      inspectOpenLink(value, expectedAppId, issues);
      continue;
    }
    if (!SAFE_COMMANDS.has(command)) {
      issues.add("flow command is not in the LaunchRig policy allowlist: " + command);
      continue;
    }
    if (command === "launchApp") inspectLaunchApp(value, expectedAppId, issues);
    else if (command === "stopApp") inspectStopApp(value, expectedAppId, issues);
    else if (command === "runFlow" || command === "repeat" || command === "retry") {
      inspectNestedCommands(value, command, expectedAppId, issues);
    }
  }
}

export function validateMaestroFlowSafety(source: string, expectedAppId: string): string[] {
  if (Buffer.byteLength(source, "utf8") > 512 * 1024) return ["flow exceeds the 512 KiB safety limit"];

  const documents = parseAllDocuments(source, { prettyErrors: false, uniqueKeys: true });
  if (documents.length !== 2 || documents.some((document) => document.errors.length > 0)) {
    return ["flow must be strict YAML with exactly one metadata document and one command document"];
  }

  const issues = new Set<string>();
  for (const document of documents) {
    let hasAlias = false;
    visit(document, {
      Node(_key, node) {
        if (isAlias(node)) hasAlias = true;
      },
    });
    if (hasAlias) issues.add("flow must not use YAML aliases");
  }

  let metadata: unknown;
  let commands: unknown;
  try {
    metadata = documents[0]?.toJS({ maxAliasCount: 0 });
    commands = documents[1]?.toJS({ maxAliasCount: 0 });
  } catch {
    issues.add("flow must not use YAML aliases");
    return [...issues].sort();
  }

  if (!isRecord(metadata)) {
    issues.add("flow metadata must be an object");
  } else {
    const metadataKeys = Object.keys(metadata);
    if (metadataKeys.some((key) => !["appId", "name", "tags"].includes(key))) {
      issues.add("flow metadata may contain only appId, name, and tags");
    }
    if (metadata.appId !== expectedAppId) {
      issues.add("flow appId must match the configured project package");
    }
  }
  if (!Array.isArray(commands) || commands.length === 0) {
    issues.add("flow command document must be a non-empty array");
  } else {
    inspectCommands(commands, expectedAppId, issues);
  }
  if (containsInterpolation(metadata) || containsInterpolation(commands)) {
    issues.add("flow must not interpolate environment variables or script output");
  }
  return [...issues].sort();
}

export function validatePilotFlowReadiness(source: string): string[] {
  if (Buffer.byteLength(source, "utf8") > 512 * 1024) return ["flow exceeds the 512 KiB safety limit"];
  const documents = parseAllDocuments(source, { prettyErrors: false, uniqueKeys: true });
  if (documents.length !== 2 || documents.some((document) => document.errors.length > 0)) {
    return ["flow must be strict YAML before pilot readiness can be checked"];
  }
  let commands: unknown;
  try {
    commands = documents[1]?.toJS({ maxAliasCount: 0 });
  } catch {
    return ["flow must not use YAML aliases"];
  }
  if (!Array.isArray(commands) || commands.length === 0) {
    return ["flow command document must be a non-empty array"];
  }
  const issues = new Set<string>();
  inspectPilotCommands(commands, issues);
  return [...issues].sort();
}
