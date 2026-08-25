import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { validateArtifact } from "./artifact-validation.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "fixtures", "mock-mwa-main.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const cacheDirectory = path.join(root, ".launchrig", "cache");
const sourceDirectory = path.join(cacheDirectory, "sources", "mock-mwa-wallet");
const outputDirectory = path.join(cacheDirectory, "apks");
const gradleUserHome = path.join(cacheDirectory, "gradle");
const artifactContract = "fixtures/mock-mwa-main.json#validatedArtifact";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(command + " failed with " + (signal ? "signal " + signal : "exit code " + code)));
    });
  });
}

async function output(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8").trim());
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || command + " failed"));
    });
  });
}

async function findDirectory(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

await mkdir(path.dirname(sourceDirectory), { recursive: true });
await mkdir(outputDirectory, { recursive: true });
await mkdir(gradleUserHome, { recursive: true });

if (!(await exists(path.join(sourceDirectory, ".git")))) {
  await run("git", ["clone", "--filter=blob:none", "--no-checkout", manifest.source, sourceDirectory]);
  await run("git", ["-C", sourceDirectory, "fetch", "--depth", "1", "origin", manifest.commit]);
  await run("git", ["-C", sourceDirectory, "checkout", "--detach", manifest.commit]);
}

const actualCommit = await output("git", ["-C", sourceDirectory, "rev-parse", "HEAD"]);
if (actualCommit !== manifest.commit) {
  throw new Error("Mock MWA source cache is at " + actualCommit + "; expected " + manifest.commit);
}
const sourceStatus = await output("git", [
  "-C",
  sourceDirectory,
  "status",
  "--porcelain=v1",
  "--untracked-files=all",
]);
if (sourceStatus) {
  throw new Error(
    "Mock MWA source cache has nonignored changes. Restore the pinned checkout before building:\n" + sourceStatus,
  );
}

const sdkRoot = await findDirectory([
  process.env.ANDROID_SDK_ROOT,
  process.env.ANDROID_HOME,
  path.join(os.homedir(), "Library", "Android", "sdk"),
  "/opt/homebrew/share/android-commandlinetools",
]);
if (!sdkRoot) throw new Error("Android SDK not found. Set ANDROID_SDK_ROOT.");

const javaHome = await findDirectory([
  process.env.LAUNCHRIG_JAVA_HOME,
  process.env.JAVA_HOME,
  "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
]);
if (!javaHome) throw new Error("JDK 17 not found. Set LAUNCHRIG_JAVA_HOME.");

const localProperties = "sdk.dir=" + sdkRoot.replaceAll("\\", "\\\\") + "\n";
await writeFile(path.join(sourceDirectory, "local.properties"), localProperties, "utf8");

const wrapper = path.join(sourceDirectory, process.platform === "win32" ? "gradlew.bat" : "gradlew");
await run(
  wrapper,
  [
    "--no-daemon",
    "--max-workers=1",
    "-Dorg.gradle.jvmargs=-Xmx1536m -Dfile.encoding=UTF-8",
    ":app:assembleDebug",
  ],
  {
    cwd: sourceDirectory,
    env: {
      ...process.env,
      ANDROID_HOME: sdkRoot,
      ANDROID_SDK_ROOT: sdkRoot,
      GRADLE_USER_HOME: gradleUserHome,
      JAVA_HOME: javaHome,
    },
  },
);

const builtApk = path.join(sourceDirectory, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const targetApk = path.join(outputDirectory, manifest.artifactName);
const temporaryApk = targetApk + ".part";
const provenancePath = targetApk.replace(/\.apk$/, ".provenance.json");
const provenancePart = provenancePath + ".part";
await unlink(temporaryApk).catch(() => undefined);
await unlink(provenancePart).catch(() => undefined);
try {
  await copyFile(builtApk, temporaryApk);
  const bytes = await readFile(temporaryApk);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const metadata = await stat(temporaryApk);
  const validation = validateArtifact(
    { size: metadata.size, sha256: digest },
    manifest.validatedArtifact,
    artifactContract,
  );
  await writeFile(
    provenancePart,
    JSON.stringify(
      {
        schemaVersion: 1,
        source: manifest.source,
        commit: manifest.commit,
        packageName: manifest.packageName,
        versionName: manifest.versionName,
        versionCode: manifest.versionCode,
        buildType: manifest.buildType,
        validation,
        size: metadata.size,
        sha256: digest,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await rename(temporaryApk, targetApk);
  await rename(provenancePart, provenancePath);

  console.log("built " + path.relative(root, targetApk));
  console.log("sha256 " + digest);
} catch (error) {
  await unlink(temporaryApk).catch(() => undefined);
  await unlink(provenancePart).catch(() => undefined);
  throw error;
}
