import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export interface RegularFileHash {
  sha256: string;
  sizeBytes: number;
  dev: string;
  ino: string;
  mode: number;
}

export class SecureFileError extends Error {
  constructor(
    message: string,
    readonly reason: "exists" | "unsafe" | "write",
  ) {
    super(message);
    this.name = "SecureFileError";
  }
}

export interface PrivateFileIdentity {
  canonicalPath: string;
  dev: number;
  ino: number;
  sizeBytes: number;
  mode: number;
  sha256: string;
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = path.normalize(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function isRegularFileNoFollow(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    return (await handle.stat()).isFile();
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readBoundedRegularFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("invalid file size limit");
  let handle;
  try {
    const before = await lstat(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes)
    ) {
      throw new Error("unsafe file");
    }
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.size < 1n ||
      opened.size > BigInt(maximumBytes) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs
    ) {
      throw new Error("unsafe file");
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
    const afterPath = await lstat(filePath, { bigint: true });
    if (
      bytesRead !== expectedSize ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino ||
      afterPath.size !== opened.size ||
      afterPath.mtimeNs !== opened.mtimeNs ||
      afterPath.ctimeNs !== opened.ctimeNs
    ) {
      throw new Error("file changed while being read");
    }
    return Buffer.from(buffer.subarray(0, expectedSize));
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readBoundedUtf8File(filePath: string, maximumBytes: number): Promise<string> {
  const bytes = await readBoundedRegularFile(filePath, maximumBytes);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function hashRegularFileNoFollow(
  filePath: string,
  maximumBytes: number,
): Promise<RegularFileHash> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("invalid file size limit");
  let handle;
  try {
    const before = await lstat(filePath, { bigint: true });
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes)
    ) {
      throw new Error("unsafe file");
    }
    handle = await open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
    );
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.size < 1n ||
      opened.size > BigInt(maximumBytes) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs
    ) {
      throw new Error("unsafe file");
    }

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const expectedSize = Number(opened.size);
    let bytesRead = 0;
    while (bytesRead < expectedSize) {
      const length = Math.min(buffer.length, expectedSize - bytesRead);
      const result = await handle.read(buffer, 0, length, bytesRead);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
    }

    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(filePath, { bigint: true });
    if (
      bytesRead !== expectedSize ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino ||
      afterPath.size !== opened.size ||
      afterPath.mtimeNs !== opened.mtimeNs ||
      afterPath.ctimeNs !== opened.ctimeNs
    ) {
      throw new Error("file changed while being hashed");
    }
    return {
      sha256: hash.digest("hex"),
      sizeBytes: expectedSize,
      dev: opened.dev.toString(),
      ino: opened.ino.toString(),
      mode: Number(opened.mode),
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeNewPrivateFileNoFollow(
  filePath: string,
  bytes: Buffer,
): Promise<PrivateFileIdentity> {
  const requestedPath = path.resolve(filePath);
  const requestedParent = path.dirname(requestedPath);
  let canonicalParent: string;
  let parentBefore: Awaited<ReturnType<typeof lstat>>;
  try {
    parentBefore = await lstat(requestedParent);
    if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) {
      throw new SecureFileError("Private output parent is unsafe", "unsafe");
    }
    canonicalParent = await realpath(requestedParent);
    if (!sameCanonicalPath(canonicalParent, requestedParent)) {
      throw new SecureFileError("Private output parent contains a symbolic-link component", "unsafe");
    }
  } catch (error) {
    if (error instanceof SecureFileError) throw error;
    throw new SecureFileError("Private output parent is unsafe", "unsafe");
  }
  const canonicalPath = path.join(canonicalParent, path.basename(requestedPath));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      canonicalPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const opened = await handle.stat();
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      !opened.isFile() ||
      opened.size !== bytes.length ||
      opened.nlink !== 1 ||
      (currentUid !== null && opened.uid !== currentUid) ||
      (process.platform !== "win32" && (opened.mode & 0o777) !== 0o600)
    ) {
      throw new SecureFileError("Private output cannot be verified", "write");
    }
    const parentAfter = await lstat(requestedParent);
    const resolvedParentAfter = await realpath(requestedParent);
    const afterPath = await lstat(canonicalPath);
    if (
      parentAfter.isSymbolicLink() ||
      !parentAfter.isDirectory() ||
      !sameFileIdentity(parentBefore, parentAfter) ||
      resolvedParentAfter !== canonicalParent ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !sameFileIdentity(opened, afterPath) ||
      afterPath.size !== bytes.length ||
      afterPath.nlink !== 1 ||
      (currentUid !== null && afterPath.uid !== currentUid) ||
      (process.platform !== "win32" && (afterPath.mode & 0o777) !== 0o600)
    ) {
      throw new SecureFileError("Private output changed while being written", "write");
    }
    return {
      canonicalPath,
      dev: opened.dev,
      ino: opened.ino,
      sizeBytes: opened.size,
      mode: opened.mode,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "EEXIST") throw new SecureFileError("Private output already exists", "exists");
    if (error instanceof SecureFileError) throw error;
    throw new SecureFileError("Private output cannot be written", "write");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function privateFileIdentityMatches(identity: PrivateFileIdentity): Promise<boolean> {
  try {
    const before = await lstat(identity.canonicalPath);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.dev !== identity.dev ||
      before.ino !== identity.ino ||
      before.size !== identity.sizeBytes ||
      before.mode !== identity.mode
    ) {
      return false;
    }
    const currentHash = await hashRegularFileNoFollow(identity.canonicalPath, identity.sizeBytes);
    return !(
      currentHash.sizeBytes !== identity.sizeBytes ||
      currentHash.sha256 !== identity.sha256 ||
      currentHash.dev !== String(identity.dev) ||
      currentHash.ino !== String(identity.ino) ||
      currentHash.mode !== identity.mode
    );
  } catch {
    return false;
  }
}
