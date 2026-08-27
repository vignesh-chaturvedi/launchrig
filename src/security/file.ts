import { constants } from "node:fs";
import { open } from "node:fs/promises";

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
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) throw new Error("unsafe file");
    const bytes = await handle.readFile();
    if (bytes.length > maximumBytes) throw new Error("file changed while being read");
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readBoundedUtf8File(filePath: string, maximumBytes: number): Promise<string> {
  const bytes = await readBoundedRegularFile(filePath, maximumBytes);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
