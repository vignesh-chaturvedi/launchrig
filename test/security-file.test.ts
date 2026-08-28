import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readBoundedRegularFile } from "../src/security/file.js";

test("bounded file reads never accept torn bytes or a symlink during mutation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrig-stable-read-"));
  try {
    const target = path.join(directory, "flow.yaml");
    const linked = path.join(directory, "linked-flow.yaml");
    const first = Buffer.alloc(512 * 1024, 0x41);
    const second = Buffer.alloc(512 * 1024, 0x42);
    await writeFile(target, first);
    await symlink(target, linked);
    await assert.rejects(() => readBoundedRegularFile(linked, first.length));

    const accepted: Buffer[] = [];
    const writer = (async () => {
      for (let index = 0; index < 40; index += 1) {
        await writeFile(target, index % 2 === 0 ? second : first);
      }
    })();
    for (let index = 0; index < 40; index += 1) {
      try {
        accepted.push(await readBoundedRegularFile(target, first.length));
      } catch {
        // A concurrent change must be rejected rather than returned as evidence bytes.
      }
    }
    await writer;
    accepted.push(await readBoundedRegularFile(target, first.length));

    assert.ok(accepted.length > 0);
    for (const bytes of accepted) {
      assert.equal(bytes.length, first.length);
      const expected = bytes[0];
      assert.ok(expected === 0x41 || expected === 0x42);
      assert.ok(bytes.every((byte) => byte === expected));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
