import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  privateFileIdentityMatches,
  SecureFileError,
  writeNewPrivateFileNoFollow,
} from "../security/file.js";
import {
  auditPrivateCohortRegister,
  CohortRegisterError,
} from "./cohort-register.js";
import { sha256Value } from "./store.js";

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const PREPARATION_LIMITATIONS = [
  "This draft creates private bookkeeping infrastructure only. It does not identify, contact, recruit, or accept a publisher candidate.",
  "Fresh opaque references do not authenticate the operator or prove publisher identity, authority, consent, project ownership, or independence.",
  "The draft authorizes no installation, publisher-project change, device access, wallet action, evidence sharing, or public claim.",
  "File ownership and mode checks do not prove ACL, backup, sync, or cloud-storage privacy.",
  "Human recruitment, fit review, Stage A permission, exact Stage B scope approval, and attended execution remain separate steps.",
] as const;

interface PrivateCohortRegisterDraft {
  schemaVersion: 1;
  kind: "launchrig-private-cohort-register";
  profile: "phase-2c-publisher-governance-v1";
  privacyProfile: "opaque-refs-digests-dates-v1";
  registerRef: string;
  revision: 1;
  asOfDate: string;
  operatorRef: string;
  candidates: [];
  defects: [];
  integritySha256: null;
}

export interface PreparePrivateCohortRegisterOptions {
  outputPath: string;
}

export interface PreparePrivateCohortRegisterDependencies {
  auditPrivateCohortRegister?: typeof auditPrivateCohortRegister;
  privateFileIdentityMatches?: typeof privateFileIdentityMatches;
}

export interface PrivateCohortRegisterDraftResultV1 {
  schemaVersion: 1;
  kind: "launchrig-private-cohort-register-draft-result";
  profile: "phase-2i-recruitment-register-v1";
  claimStatus: "operator-prepared-unattested";
  status: "created";
  fileSha256: string;
  contentSha256: string;
  revision: 1;
  targetPublisherProjects: 3;
  candidateRecords: 0;
  interestRecorded: 0;
  integrityRecorded: false;
  humanRecruitmentRequired: true;
  projectModificationAuthorized: false;
  phoneAccessAuthorized: false;
  pilotStateChecked: false;
  deviceEnvironmentChecked: false;
  candidatePool: "not-established";
  publisherIdentity: "not-established";
  publisherAuthority: "not-established";
  publisherConsent: "not-established";
  publisherIndependence: "not-established";
  externalGrantGate: "not-established";
  grantReady: false;
  limitations: string[];
}

function typedRef(kind: "register" | "operator"): string {
  const uuid = randomUUID();
  if (!UUID_V4.test(uuid)) {
    throw new CohortRegisterError("Secure private register references cannot be generated", 3);
  }
  return "urn:launchrig:" + kind + ":" + uuid;
}

function currentUtcDate(): string {
  const now = new Date();
  if (!Number.isFinite(now.valueOf())) {
    throw new CohortRegisterError("Current date is invalid", 3);
  }
  return now.toISOString().slice(0, 10);
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))
  );
}

async function activeGitWorktreeRoot(startPath: string): Promise<string | null> {
  let current = await realpath(startPath);
  while (true) {
    try {
      const metadata = await lstat(path.join(current, ".git"));
      if (metadata.isSymbolicLink()) {
        throw new CohortRegisterError("Active Git worktree metadata is unsafe", 3);
      }
      if (metadata.isDirectory() || metadata.isFile()) return current;
      throw new CohortRegisterError("Active Git worktree metadata is unsafe", 3);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== "ENOENT") {
        throw new CohortRegisterError("Active Git worktree cannot be inspected safely", 3);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function assertOutsideActiveGitWorktree(outputPath: string): Promise<void> {
  const root = await activeGitWorktreeRoot(process.cwd());
  if (!root) return;
  let outputParent: string;
  try {
    outputParent = await realpath(path.dirname(path.resolve(outputPath)));
  } catch {
    throw new CohortRegisterError("Private register output parent cannot be resolved safely", 3);
  }
  const candidate = path.join(outputParent, path.basename(path.resolve(outputPath)));
  if (isContained(root, candidate)) {
    throw new CohortRegisterError("Private register output must be outside the active Git worktree");
  }
}

function draftRegister(): PrivateCohortRegisterDraft {
  const registerRef = typedRef("register");
  const operatorRef = typedRef("operator");
  if (registerRef.slice(-36) === operatorRef.slice(-36)) {
    throw new CohortRegisterError("Distinct private register references cannot be generated", 3);
  }
  return {
    schemaVersion: 1,
    kind: "launchrig-private-cohort-register",
    profile: "phase-2c-publisher-governance-v1",
    privacyProfile: "opaque-refs-digests-dates-v1",
    registerRef,
    revision: 1,
    asOfDate: currentUtcDate(),
    operatorRef,
    candidates: [],
    defects: [],
    integritySha256: null,
  };
}

export async function preparePrivateCohortRegister(
  options: PreparePrivateCohortRegisterOptions,
  dependencies: PreparePrivateCohortRegisterDependencies = {},
): Promise<PrivateCohortRegisterDraftResultV1> {
  if (
    typeof options.outputPath !== "string" ||
    options.outputPath.length < 1 ||
    options.outputPath.length > 4096 ||
    options.outputPath.trim().length === 0 ||
    /[\u0000-\u001f\u007f]/.test(options.outputPath)
  ) {
    throw new CohortRegisterError("Private register output path is invalid");
  }
  if (!path.isAbsolute(options.outputPath)) {
    throw new CohortRegisterError("Private register output path must be absolute");
  }
  await assertOutsideActiveGitWorktree(options.outputPath);

  const register = draftRegister();
  const registerCore = {
    schemaVersion: register.schemaVersion,
    kind: register.kind,
    profile: register.profile,
    privacyProfile: register.privacyProfile,
    registerRef: register.registerRef,
    revision: register.revision,
    asOfDate: register.asOfDate,
    operatorRef: register.operatorRef,
    candidates: register.candidates,
    defects: register.defects,
  };
  const contentSha256 = sha256Value(registerCore);
  const bytes = Buffer.from(JSON.stringify(register, null, 2) + "\n", "utf8");

  let identity;
  try {
    identity = await writeNewPrivateFileNoFollow(options.outputPath, bytes);
  } catch (error) {
    if (error instanceof SecureFileError) {
      if (error.reason === "exists") {
        throw new CohortRegisterError("Private register output already exists");
      }
      if (error.reason === "write") {
        throw new CohortRegisterError(
          "Private register output could not be verified after creation; a mode-600 file may remain for manual inspection",
          3,
        );
      }
      throw new CohortRegisterError("Private register output cannot be created safely", 3);
    }
    throw error;
  }

  let audit;
  try {
    const auditRegister = dependencies.auditPrivateCohortRegister ?? auditPrivateCohortRegister;
    audit = await auditRegister(identity.canonicalPath);
  } catch {
    throw new CohortRegisterError(
      "Private register output could not be verified after creation; a mode-600 file may remain for manual inspection",
      3,
    );
  }
  if (
    audit.register.fileSha256 !== identity.sha256 ||
    audit.register.contentSha256 !== contentSha256 ||
    audit.register.revision !== 1 ||
    audit.register.integrityRecorded !== false ||
    audit.summary.candidateRecords !== 0 ||
    audit.summary.interestRecorded !== 0 ||
    audit.summary.recordedGovernanceAndTechnicalThresholdMet !== false ||
    audit.externalGrantGate.status !== "not-established" ||
    audit.grantReady !== false ||
    !(await (dependencies.privateFileIdentityMatches ?? privateFileIdentityMatches)(identity))
  ) {
    throw new CohortRegisterError(
      "Private register output could not be verified after creation; a mode-600 file may remain for manual inspection",
      3,
    );
  }

  return {
    schemaVersion: 1,
    kind: "launchrig-private-cohort-register-draft-result",
    profile: "phase-2i-recruitment-register-v1",
    claimStatus: "operator-prepared-unattested",
    status: "created",
    fileSha256: identity.sha256,
    contentSha256,
    revision: 1,
    targetPublisherProjects: 3,
    candidateRecords: 0,
    interestRecorded: 0,
    integrityRecorded: false,
    humanRecruitmentRequired: true,
    projectModificationAuthorized: false,
    phoneAccessAuthorized: false,
    pilotStateChecked: false,
    deviceEnvironmentChecked: false,
    candidatePool: "not-established",
    publisherIdentity: "not-established",
    publisherAuthority: "not-established",
    publisherConsent: "not-established",
    publisherIndependence: "not-established",
    externalGrantGate: "not-established",
    grantReady: false,
    limitations: [...PREPARATION_LIMITATIONS],
  };
}
