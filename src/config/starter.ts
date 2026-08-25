export const STARTER_CONFIG = `# LaunchRig v1: physical Android device first
version: 1

project:
  name: My Solana Mobile App
  packageName: com.example.app
  # apk: ./build/app-devnet.apk
  install: false
  # Use always for changing app builds; if-missing is useful for pinned fixtures.
  installPolicy: always

target:
  # Product tests default to devnet. The pinned official reference fakedapp is
  # the only bundled exception because its upstream APK is hard-coded to testnet.
  # Phase 1 intentionally refuses mainnet.
  network: devnet

device:
  # Select a device at runtime with --device; never commit its serial.
  requirePhysical: true
  minimumApiLevel: 26

wallet:
  mode: mock-mwa
  packageName: com.solana.mwallet
  install: false
  installPolicy: if-missing

# Add publisher-authored Maestro flows after the device doctor passes.
scenarios: []

artifacts:
  directory: ./.launchrig/results
  screenshots: failure
  retention: 5

privacy:
  includeLogcat: false
  logcatLines: 200
  redactPatterns: []

tooling: {}
`;
