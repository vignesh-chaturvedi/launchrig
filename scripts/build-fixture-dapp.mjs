import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { candidateArtifactName, classifyArtifact } from "./artifact-validation.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = path.join(root, "apps", "fixture-dapp");
const fixtureManifestPath = path.join(root, "fixtures", "launchrig-dapp-v0.2.0.json");
const fixtureManifest = JSON.parse(await readFile(fixtureManifestPath, "utf8"));
const lockfilePath = path.join(fixtureDirectory, "pnpm-lock.yaml");
const packagePath = path.join(fixtureDirectory, "package.json");
const appConfigPath = path.join(fixtureDirectory, "app.json");
const androidDirectory = path.join(fixtureDirectory, "android");
const cacheDirectory = path.join(root, ".launchrig", "cache");
const outputDirectory = path.join(cacheDirectory, "apks");
const gradleUserHome = path.join(cacheDirectory, "gradle-fixture");
const artifactName = fixtureManifest.build?.artifactName;
const targetApk = path.join(outputDirectory, artifactName);
const temporaryApk = targetApk + ".part";
const provenancePath = targetApk.replace(/\.apk$/, ".provenance.json");
const architecture = fixtureManifest.build?.architectures?.[0];
const gradleHeapMb = fixtureManifest.build?.gradleHeapMb;
const gradleWorkers = fixtureManifest.build?.gradleWorkers;
const artifactContract = "fixtures/launchrig-dapp-v0.2.0.json#validatedArtifact";

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
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) resolve(options.trim === false ? stdoutText : stdoutText.trim() || stderrText);
      else reject(new Error(stderrText || stdoutText.trim() || command + " failed"));
    });
  });
}

async function optionalOutput(command, args, options = {}) {
  try {
    return await output(command, args, options);
  } catch {
    return null;
  }
}

async function sha256(target) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = createReadStream(target);
    input.once("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("end", resolve);
  });
  return hash.digest("hex");
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function fixtureSourceSnapshot() {
  const sourceCommit = await output("git", ["rev-parse", "HEAD"], { cwd: root });
  const sourceStatus =
    (await output(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all", "--", "apps/fixture-dapp"],
      { cwd: root, trim: false },
    )) ?? "";
  const sourceFiles = (
    (await output(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "apps/fixture-dapp"],
      { cwd: root, trim: false },
    )) ?? ""
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const sourceHash = createHash("sha256");

  for (const sourceFile of sourceFiles) {
    const filePath = path.join(root, sourceFile);
    sourceHash.update("path\0" + Buffer.byteLength(sourceFile, "utf8") + "\0" + sourceFile + "\0");
    try {
      const bytes = await readFile(filePath);
      sourceHash.update("file\0" + bytes.byteLength + "\0");
      sourceHash.update(bytes);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      sourceHash.update("missing\0");
    }
  }

  return {
    sourceCommit,
    sourceDirty: Boolean(sourceStatus),
    sourceStatusSha256: createHash("sha256").update(sourceStatus).digest("hex"),
    sourceTreeSha256: sourceHash.digest("hex"),
    sourceFileCount: sourceFiles.length,
  };
}

function assertUnchangedSource(before, after) {
  if (
    before.sourceCommit !== after.sourceCommit ||
    before.sourceDirty !== after.sourceDirty ||
    before.sourceStatusSha256 !== after.sourceStatusSha256 ||
    before.sourceTreeSha256 !== after.sourceTreeSha256 ||
    before.sourceFileCount !== after.sourceFileCount
  ) {
    throw new Error("Fixture source changed during the build. Discard this build and run it again.");
  }
}

async function findAndroidSdk() {
  const candidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    process.platform === "darwin" ? path.join(os.homedir(), "Library", "Android", "sdk") : undefined,
    process.platform === "linux" ? path.join(os.homedir(), "Android", "Sdk") : undefined,
    "/opt/homebrew/share/android-commandlinetools",
    "/opt/android-sdk",
  ];

  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    if (
      (await exists(candidate)) &&
      (await exists(path.join(candidate, "build-tools"))) &&
      (await exists(path.join(candidate, "platforms")))
    ) {
      return candidate;
    }
  }

  throw new Error("Android SDK not found. Set ANDROID_SDK_ROOT to an SDK with build-tools and platforms.");
}

async function java17At(candidate) {
  if (!candidate) return null;
  const executable = path.join(candidate, "bin", process.platform === "win32" ? "java.exe" : "java");
  if (!(await exists(executable))) return null;

  const version = await optionalOutput(executable, ["-version"]);
  const major = version?.match(/version [\"'](?:1\.)?(\d+)/)?.[1];
  return major === "17" ? { home: candidate, version: version.split("\n")[0] } : null;
}

async function findJava17() {
  if (process.env.LAUNCHRIG_JAVA_HOME) {
    const configured = await java17At(process.env.LAUNCHRIG_JAVA_HOME);
    if (!configured) throw new Error("LAUNCHRIG_JAVA_HOME must point to JDK 17.");
    return configured;
  }

  const javaHome17 =
    process.platform === "darwin" ? await optionalOutput("/usr/libexec/java_home", ["-v", "17"]) : null;
  const candidates = [
    process.env.JAVA_HOME,
    javaHome17,
    "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
    "/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
    "/usr/lib/jvm/java-17-openjdk-amd64",
    "/usr/lib/jvm/java-17-openjdk",
  ];

  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const detected = await java17At(candidate);
    if (detected) return detected;
  }

  throw new Error("JDK 17 not found. Set LAUNCHRIG_JAVA_HOME to a JDK 17 installation.");
}

async function verifyArm64Only(apkPath) {
  const listing = await output("unzip", ["-Z1", apkPath]);
  const architectures = [
    ...new Set(
      listing
        .split("\n")
        .map((entry) => entry.match(/^lib\/([^/]+)\//)?.[1])
        .filter(Boolean),
    ),
  ].sort();

  if (architectures.length !== 1 || architectures[0] !== architecture) {
    throw new Error("Expected an arm64-v8a-only APK, found: " + (architectures.join(", ") || "no native ABI"));
  }
}

const rootPackage = await readJson(path.join(root, "package.json"));
const fixturePackage = await readJson(packagePath);
const appConfig = await readJson(appConfigPath);
if (
  fixtureManifest.schemaVersion !== 1 ||
  typeof artifactName !== "string" ||
  fixtureManifest.build?.architectures?.length !== 1 ||
  architecture !== "arm64-v8a" ||
  !Number.isInteger(gradleHeapMb) ||
  !Number.isInteger(gradleWorkers) ||
  (fixtureManifest.validatedArtifact !== null &&
    (!Number.isSafeInteger(fixtureManifest.validatedArtifact?.size) ||
      fixtureManifest.validatedArtifact.size <= 0 ||
      !/^[a-f0-9]{64}$/.test(fixtureManifest.validatedArtifact?.sha256 ?? "")))
) {
  throw new Error("fixtures/launchrig-dapp-v0.2.0.json has an invalid build contract.");
}
if (!(await exists(lockfilePath))) throw new Error("Missing apps/fixture-dapp/pnpm-lock.yaml.");
if (
  fixturePackage.version !== fixtureManifest.versionName ||
  appConfig.expo?.version !== fixtureManifest.versionName ||
  appConfig.expo?.android?.package !== fixtureManifest.packageName
) {
  throw new Error("Fixture package metadata does not match fixtures/launchrig-dapp-v0.2.0.json.");
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const pnpmVersion = await output(pnpm, ["--version"]);
const expectedPnpmVersion = String(rootPackage.packageManager ?? "").match(/^pnpm@(.+)$/)?.[1];
if (expectedPnpmVersion && pnpmVersion !== expectedPnpmVersion) {
  throw new Error("pnpm " + expectedPnpmVersion + " is required; found " + pnpmVersion + ".");
}

const java = await findJava17();
const androidSdkRoot = await findAndroidSdk();
const lockfileSha256 = await sha256(lockfilePath);
if (lockfileSha256 !== fixtureManifest.build.lockfileSha256) {
  throw new Error("Fixture lockfile checksum does not match fixtures/launchrig-dapp-v0.2.0.json.");
}
const fixtureSource = await fixtureSourceSnapshot();

const installEnvironment = { ...process.env };
delete installEnvironment.NODE_ENV;
await run(pnpm, ["install", "--frozen-lockfile", "--force"], {
  cwd: fixtureDirectory,
  env: installEnvironment,
});

const buildEnvironment = {
  ...process.env,
  ANDROID_HOME: androidSdkRoot,
  ANDROID_SDK_ROOT: androidSdkRoot,
  CI: "1",
  EXPO_NO_TELEMETRY: "1",
  GRADLE_USER_HOME: gradleUserHome,
  JAVA_HOME: java.home,
  NODE_ENV: "production",
};
delete buildEnvironment.GRADLE_OPTS;
delete buildEnvironment.JAVA_TOOL_OPTIONS;
delete buildEnvironment.JDK_JAVA_OPTIONS;
delete buildEnvironment._JAVA_OPTIONS;

await run(pnpm, ["exec", "expo", "prebuild", "--platform", "android", "--clean", "--no-install"], {
  cwd: fixtureDirectory,
  env: buildEnvironment,
});

if ((await sha256(lockfilePath)) !== lockfileSha256) {
  throw new Error("Expo prebuild changed apps/fixture-dapp/pnpm-lock.yaml.");
}

await mkdir(outputDirectory, { recursive: true });
await mkdir(gradleUserHome, { recursive: true });
await writeFile(
  path.join(androidDirectory, "local.properties"),
  "sdk.dir=" + androidSdkRoot.replaceAll("\\", "\\\\").replaceAll(":", "\\:") + "\n",
  "utf8",
);

const wrapper = path.join(androidDirectory, process.platform === "win32" ? "gradlew.bat" : "gradlew");
await run(
  wrapper,
  [
    "--no-daemon",
    "--max-workers=" + gradleWorkers,
    "-Dorg.gradle.parallel=false",
    "-Dorg.gradle.jvmargs=-Xmx" + gradleHeapMb + "m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8",
    "-PreactNativeArchitectures=" + architecture,
    ":app:assembleRelease",
  ],
  { cwd: androidDirectory, env: buildEnvironment },
);

const builtApk = path.join(androidDirectory, "app", "build", "outputs", "apk", "release", "app-release.apk");
const outputMetadata = await readJson(
  path.join(androidDirectory, "app", "build", "outputs", "apk", "release", "output-metadata.json"),
);
const release = outputMetadata.elements?.find((entry) => entry.outputFile === "app-release.apk");
if (
  !release ||
  outputMetadata.applicationId !== fixtureManifest.packageName ||
  release.versionName !== fixtureManifest.versionName ||
  release.versionCode !== fixtureManifest.versionCode
) {
  throw new Error("Gradle release metadata does not match the fixture app configuration.");
}
await verifyArm64Only(builtApk);
assertUnchangedSource(fixtureSource, await fixtureSourceSnapshot());

await unlink(temporaryApk).catch(() => undefined);
let outputProvenancePart;
try {
  await copyFile(builtApk, temporaryApk);
  const digest = await sha256(temporaryApk);
  const metadata = await stat(temporaryApk);
  const actualArtifact = { size: metadata.size, sha256: digest };
  const classification = fixtureManifest.validatedArtifact
    ? classifyArtifact(actualArtifact, fixtureManifest.validatedArtifact, artifactContract)
    : {
        status: "candidate",
        contract: artifactContract,
        expected: null,
        actual: actualArtifact,
      };
  const outputApk =
    classification.status === "validated"
      ? targetApk
      : path.join(outputDirectory, candidateArtifactName(artifactName, digest));
  const outputProvenance =
    classification.status === "validated" ? provenancePath : outputApk.replace(/\.apk$/, ".provenance.json");
  outputProvenancePart = outputProvenance + ".part";

  const expoPackage = await readJson(path.join(fixtureDirectory, "node_modules", "expo", "package.json"));
  const gradleProperties = await readFile(
    path.join(androidDirectory, "gradle", "wrapper", "gradle-wrapper.properties"),
    "utf8",
  );
  const gradleDistribution = gradleProperties.match(/^distributionUrl=(.+)$/m)?.[1] ?? null;

  await unlink(outputProvenancePart).catch(() => undefined);
  await writeFile(
    outputProvenancePart,
    JSON.stringify(
      {
        schemaVersion: 1,
        status: classification.status,
        contract: classification.contract,
        expected: classification.expected,
        actual: classification.actual,
        manifest: path.relative(root, fixtureManifestPath),
        source: "apps/fixture-dapp",
        ...fixtureSource,
        lockfile: "apps/fixture-dapp/pnpm-lock.yaml",
        lockfileSha256,
        packageName: outputMetadata.applicationId,
        versionName: release.versionName,
        versionCode: release.versionCode,
        buildType: "release",
        architectures: [architecture],
        nodeEnv: buildEnvironment.NODE_ENV,
        gradleWorkers,
        gradleHeapMb,
        validation: classification,
        toolchain: {
          node: process.version,
          pnpm: pnpmVersion,
          expo: expoPackage.version,
          java: java.version,
          gradleDistribution,
        },
        artifact: path.relative(root, outputApk),
        size: metadata.size,
        sha256: digest,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await rename(temporaryApk, outputApk);
  await rename(outputProvenancePart, outputProvenance);

  if (classification.status === "candidate") {
    console.log("candidate " + path.relative(root, outputApk));
    console.log("candidate provenance " + path.relative(root, outputProvenance));
    console.log("stable validated artifact unchanged " + path.relative(root, targetApk));
  } else {
    console.log("built " + path.relative(root, targetApk));
    console.log("provenance " + path.relative(root, provenancePath));
  }
  console.log("sha256 " + digest);
} catch (error) {
  await unlink(temporaryApk).catch(() => undefined);
  if (outputProvenancePart) await unlink(outputProvenancePart).catch(() => undefined);
  throw error;
}
