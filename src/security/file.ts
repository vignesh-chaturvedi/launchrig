import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

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
  let handle;
  try {
    const before = await lstat(filePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximumBytes)) {
      throw new Error("unsafe file");
    }
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
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
