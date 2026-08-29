import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { parseDocument } from "yaml";
import { sha256Value } from "./store.js";

const MAX_SCOPE_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SCENARIO_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CORE_MWA_KINDS = ["mwa-authorize", "mwa-siws", "mwa-sign-message", "mwa-reject"] as const;
const SCREENSHOT_MODES = ["failure", "always", "never"] as const;
const DELETION_METHODS = [
  "standard-delete",
  "secure-delete",
  "publisher-managed",
  "other-documented",
] as const;

const RECEIPT_LIMITATIONS = [
  "The receipt is derived from an operator-prepared private scope file and is not a signature, publisher attestation, or proof of consent.",
  "Declared digests bind the scope document but do not independently verify the bundle, app, wallet, flow artifacts, publisher identity, operator authority, or device environment.",
  "Policy validity does not establish an external publisher, a completed pilot, a confirmed defect, Seeker hardware, production-wallet behavior, Seed Vault behavior, or grant readiness.",
] as const;

type CoreMwaKind = (typeof CORE_MWA_KINDS)[number];
type ScreenshotMode = (typeof SCREENSHOT_MODES)[number];
type DeletionMethod = (typeof DELETION_METHODS)[number];

export interface PilotSessionScopeFlow {
  kind: CoreMwaKind;
  scenarioId: string;
  fileSha256: string;
}

export interface PilotSessionScopeV1 {
  schemaVersion: 1;
  kind: "launchrig-pilot-session-scope";
  profile: "external-mwa-pilot-scope-v1";
  scopeRef: string;
  operatorRef: string;
  pilotRef: string;
  deviceRef: string;
  bundle: {
    bundleId: string;
    manifestSha256: string;
    sha256SumsSha256: string;
    packageSha256: string;
  };
  inputs: {
    configSha256: string;
    appBuildSha256: string;
    walletArtifactSha256: string;
    flows: PilotSessionScopeFlow[];
  };
  policy: {
    network: "devnet" | "testnet";
    walletMode: "mock-mwa" | "reference-fakewallet";
    physicalAndroidRequired: true;
    attendedExecutionRequired: true;
    manualWalletActionsRequired: true;
    valuableAssetsAllowed: false;
    capture: {
      screenshots: ScreenshotMode;
      includeLogcat: boolean;
      logcatLines: number;
    };
    retention: {
      maxRuns: number;
      expiresOn: string;
      deletionMethod: DeletionMethod;
    };
    sharing: {
      publicEvidenceJson: boolean;
      sanitizedReports: boolean;
      publisherName: boolean;
      publisherLogo: boolean;
      approvedQuote: boolean;
      confirmedDefectRecord: boolean;
    };
  };
}

export interface PilotSessionScopeReceiptV1 {
  receiptSchemaVersion: 1;
  kind: "launchrig-pilot-session-scope-receipt";
  profile: "external-mwa-pilot-scope-v1";
  binding: {
    bundleId: string;
    packageSha256: string;
    appBuildSha256: string;
    walletArtifactSha256: string;
    flowReviewSha256: string;
    scopeSha256: string;
  };
  bundleVerification: {
    manifestSha256: string;
    sha256SumsSha256: string;
  };
  scopeFileSha256: string;
  policyValid: true;
  claimStatus: "operator-prepared-unattested";
  publisherIdentity: "not-established";
  consentAuthenticity: "not-established";
  deviceEnvironment: "not-established";
  externalGrantGate: "not-established";
  grantReady: false;
  limitations: string[];
}

export class PilotSessionScopeError extends Error {
  constructor(
    message: string,
    readonly exitCode: 2 | 3 = 2,
  ) {
    super(message);
    this.name = "PilotSessionScopeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new PilotSessionScopeError(label + " must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new PilotSessionScopeError(label + " must contain exactly the supported fields");
  }
  return value;
}

function exactString(value: unknown, expected: string, label: string): typeof expected {
  if (value !== expected) throw new PilotSessionScopeError(label + " is unsupported");
  return expected;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new PilotSessionScopeError(label + " must be a lowercase SHA-256 digest");
  }
  return value;
}

function bundleId(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new PilotSessionScopeError("Pilot session scope bundle ID is invalid");
  }
  return value;
}

function typedRef(value: unknown, type: "scope" | "operator" | "pilot" | "device"): string {
  const prefix = "urn:launchrig:" + type + ":";
  if (typeof value !== "string" || !value.startsWith(prefix) || !UUID_V4.test(value.slice(prefix.length))) {
    throw new PilotSessionScopeError("Pilot session scope " + type + " reference is invalid");
  }
  return value;
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  choices: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    throw new PilotSessionScopeError(label + " is invalid");
  }
  return value as Values[number];
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new PilotSessionScopeError(label + " must be true or false");
  return value;
}

function fixedBoolean<const Expected extends boolean>(
  value: unknown,
  expected: Expected,
  label: string,
): Expected {
  if (value !== expected) throw new PilotSessionScopeError(label + " violates the safe pilot policy");
  return expected;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new PilotSessionScopeError(label + " is outside the supported range");
  }
  return value as number;
}

function strictDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PilotSessionScopeError("Pilot session scope retention expiry is invalid");
  }
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new PilotSessionScopeError("Pilot session scope retention expiry is invalid");
  }
  return value;
}

function parseFlows(value: unknown): PilotSessionScopeFlow[] {
  if (!Array.isArray(value) || value.length !== CORE_MWA_KINDS.length) {
    throw new PilotSessionScopeError("Pilot session scope requires exactly four MWA flows");
  }
  const parsed = value.map((entry) => {
    const record = exactRecord(entry, ["kind", "scenarioId", "fileSha256"], "Pilot session scope flow");
    const kind = oneOf(record.kind, CORE_MWA_KINDS, "Pilot session scope flow kind");
    if (typeof record.scenarioId !== "string" || !SCENARIO_ID.test(record.scenarioId)) {
      throw new PilotSessionScopeError("Pilot session scope flow scenario ID is invalid");
    }
    return {
      kind,
      scenarioId: record.scenarioId,
      fileSha256: hash(record.fileSha256, "Pilot session scope flow digest"),
    };
  });
  if (
    new Set(parsed.map((flow) => flow.kind)).size !== CORE_MWA_KINDS.length ||
    new Set(parsed.map((flow) => flow.scenarioId)).size !== CORE_MWA_KINDS.length ||
    new Set(parsed.map((flow) => flow.fileSha256)).size !== CORE_MWA_KINDS.length
  ) {
    throw new PilotSessionScopeError("Pilot session scope flows must use distinct kinds, scenario IDs, and digests");
  }
  return CORE_MWA_KINDS.map((kind) => parsed.find((flow) => flow.kind === kind)!);
}

function parseScope(value: unknown): PilotSessionScopeV1 {
  const root = exactRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "profile",
      "scopeRef",
      "operatorRef",
      "pilotRef",
      "deviceRef",
      "bundle",
      "inputs",
      "policy",
    ],
    "Pilot session scope",
  );
  if (root.schemaVersion !== 1) throw new PilotSessionScopeError("Pilot session scope schema version is unsupported");
  exactString(root.kind, "launchrig-pilot-session-scope", "Pilot session scope kind");
  exactString(root.profile, "external-mwa-pilot-scope-v1", "Pilot session scope profile");

  const bundle = exactRecord(
    root.bundle,
    ["bundleId", "manifestSha256", "sha256SumsSha256", "packageSha256"],
    "Pilot session scope bundle",
  );
  const inputs = exactRecord(
    root.inputs,
    ["configSha256", "appBuildSha256", "walletArtifactSha256", "flows"],
    "Pilot session scope inputs",
  );
  const policy = exactRecord(
    root.policy,
    [
      "network",
      "walletMode",
      "physicalAndroidRequired",
      "attendedExecutionRequired",
      "manualWalletActionsRequired",
      "valuableAssetsAllowed",
      "capture",
      "retention",
      "sharing",
    ],
    "Pilot session scope policy",
  );
  const capture = exactRecord(
    policy.capture,
    ["screenshots", "includeLogcat", "logcatLines"],
    "Pilot session scope capture policy",
  );
  const retention = exactRecord(
    policy.retention,
    ["maxRuns", "expiresOn", "deletionMethod"],
    "Pilot session scope retention policy",
  );
  const sharing = exactRecord(
    policy.sharing,
    [
      "publicEvidenceJson",
      "sanitizedReports",
      "publisherName",
      "publisherLogo",
      "approvedQuote",
      "confirmedDefectRecord",
    ],
    "Pilot session scope sharing policy",
  );

  return {
    schemaVersion: 1,
    kind: "launchrig-pilot-session-scope",
    profile: "external-mwa-pilot-scope-v1",
    scopeRef: typedRef(root.scopeRef, "scope"),
    operatorRef: typedRef(root.operatorRef, "operator"),
    pilotRef: typedRef(root.pilotRef, "pilot"),
    deviceRef: typedRef(root.deviceRef, "device"),
    bundle: {
      bundleId: bundleId(bundle.bundleId),
      manifestSha256: hash(bundle.manifestSha256, "Pilot session scope manifest digest"),
      sha256SumsSha256: hash(bundle.sha256SumsSha256, "Pilot session scope checksum inventory digest"),
      packageSha256: hash(bundle.packageSha256, "Pilot session scope package digest"),
    },
    inputs: {
      configSha256: hash(inputs.configSha256, "Pilot session scope configuration digest"),
      appBuildSha256: hash(inputs.appBuildSha256, "Pilot session scope app build digest"),
      walletArtifactSha256: hash(inputs.walletArtifactSha256, "Pilot session scope wallet artifact digest"),
      flows: parseFlows(inputs.flows),
    },
    policy: {
      network: oneOf(policy.network, ["devnet", "testnet"] as const, "Pilot session scope network"),
      walletMode: oneOf(
        policy.walletMode,
        ["mock-mwa", "reference-fakewallet"] as const,
        "Pilot session scope wallet mode",
      ),
      physicalAndroidRequired: fixedBoolean(
        policy.physicalAndroidRequired,
        true,
        "Pilot session scope physical Android requirement",
      ),
      attendedExecutionRequired: fixedBoolean(
        policy.attendedExecutionRequired,
        true,
        "Pilot session scope attended execution requirement",
      ),
      manualWalletActionsRequired: fixedBoolean(
        policy.manualWalletActionsRequired,
        true,
        "Pilot session scope manual wallet action requirement",
      ),
      valuableAssetsAllowed: fixedBoolean(
        policy.valuableAssetsAllowed,
        false,
        "Pilot session scope valuable asset policy",
      ),
      capture: {
        screenshots: oneOf(capture.screenshots, SCREENSHOT_MODES, "Pilot session scope screenshot policy"),
        includeLogcat: boolean(capture.includeLogcat, "Pilot session scope logcat policy"),
        logcatLines: integer(capture.logcatLines, 1, 1000, "Pilot session scope logcat line limit"),
      },
      retention: {
        maxRuns: integer(retention.maxRuns, 1, 25, "Pilot session scope retained run limit"),
        expiresOn: strictDate(retention.expiresOn),
        deletionMethod: oneOf(
          retention.deletionMethod,
          DELETION_METHODS,
          "Pilot session scope deletion method",
        ),
      },
      sharing: {
        publicEvidenceJson: boolean(sharing.publicEvidenceJson, "Pilot session scope public evidence policy"),
        sanitizedReports: boolean(sharing.sanitizedReports, "Pilot session scope sanitized report policy"),
        publisherName: boolean(sharing.publisherName, "Pilot session scope publisher name policy"),
        publisherLogo: boolean(sharing.publisherLogo, "Pilot session scope publisher logo policy"),
        approvedQuote: boolean(sharing.approvedQuote, "Pilot session scope quote policy"),
        confirmedDefectRecord: boolean(
          sharing.confirmedDefectRecord,
          "Pilot session scope confirmed defect record policy",
        ),
      },
    },
  };
}

async function readPrivateScope(inputPath: string): Promise<{ value: unknown; fileSha256: string }> {
  let handle;
  try {
    const before = await lstat(inputPath, { bigint: true });
    const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(MAX_SCOPE_BYTES) ||
      before.nlink !== 1n ||
      (currentUid !== null && before.uid !== currentUid) ||
      (process.platform !== "win32" && (before.mode & 0o077n) !== 0n)
    ) {
      throw new Error("unsafe private scope");
    }
    handle = await open(
      inputPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
    );
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs ||
      opened.mode !== before.mode ||
      opened.nlink !== 1n ||
      (currentUid !== null && opened.uid !== currentUid) ||
      (process.platform !== "win32" && (opened.mode & 0o077n) !== 0n)
    ) {
      throw new Error("unsafe private scope");
    }
    const expectedSize = Number(opened.size);
    const buffer = Buffer.alloc(expectedSize + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(inputPath, { bigint: true });
    if (
      bytesRead !== expectedSize ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      after.mode !== opened.mode ||
      after.nlink !== 1n ||
      (currentUid !== null && after.uid !== currentUid) ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino ||
      afterPath.size !== opened.size ||
      afterPath.mtimeNs !== opened.mtimeNs ||
      afterPath.ctimeNs !== opened.ctimeNs ||
      afterPath.mode !== opened.mode ||
      afterPath.nlink !== 1n ||
      (currentUid !== null && afterPath.uid !== currentUid) ||
      (process.platform !== "win32" && (afterPath.mode & 0o077n) !== 0n)
    ) {
      throw new Error("private scope changed while reading");
    }
    const bytes = buffer.subarray(0, expectedSize);
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new PilotSessionScopeError("Pilot session scope must use valid UTF-8");
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new PilotSessionScopeError("Pilot session scope must be strict JSON");
    }
    const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new PilotSessionScopeError("Pilot session scope must be strict JSON without duplicate keys");
    }
    return {
      value,
      fileSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof PilotSessionScopeError) throw error;
    throw new PilotSessionScopeError("Pilot session scope cannot be read safely", 3);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function createPilotSessionScopeReceipt(
  inputPath: string,
): Promise<PilotSessionScopeReceiptV1> {
  const input = await readPrivateScope(inputPath);
  const scope = parseScope(input.value);
  const flowReviewSha256 = sha256Value({
    profile: "external-mwa-flow-review-v1",
    flows: scope.inputs.flows,
  });
  return {
    receiptSchemaVersion: 1,
    kind: "launchrig-pilot-session-scope-receipt",
    profile: "external-mwa-pilot-scope-v1",
    binding: {
      bundleId: scope.bundle.bundleId,
      packageSha256: scope.bundle.packageSha256,
      appBuildSha256: scope.inputs.appBuildSha256,
      walletArtifactSha256: scope.inputs.walletArtifactSha256,
      flowReviewSha256,
      scopeSha256: sha256Value(scope),
    },
    bundleVerification: {
      manifestSha256: scope.bundle.manifestSha256,
      sha256SumsSha256: scope.bundle.sha256SumsSha256,
    },
    scopeFileSha256: input.fileSha256,
    policyValid: true,
    claimStatus: "operator-prepared-unattested",
    publisherIdentity: "not-established",
    consentAuthenticity: "not-established",
    deviceEnvironment: "not-established",
    externalGrantGate: "not-established",
    grantReady: false,
    limitations: [...RECEIPT_LIMITATIONS],
  };
}
