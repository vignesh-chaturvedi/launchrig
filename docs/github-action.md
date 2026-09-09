# Configuration-validation Action

The root `action.yml` and `action/run-validation.mjs` implement a configuration-validation Action. It validates declared configuration and input files without ADB, Maestro execution, wallet access, or a connected phone.

An example is provided in `examples/github-actions/launchrig-validation.yml`. It is a consumer template, not a deployed workflow or evidence that downstream projects use the Action. Use a reviewed immutable source reference when adopting an external Action release.

The runner requires the supported Node.js floor and resolves the versioned LaunchRig CLI from the working directory. Install and build the source before exercising the Action from this checkout. Artifact paths in the selected configuration must exist even though validation is device-free.

Inputs are passed as arguments rather than interpolated into shell source. Workspace-relative paths must remain normalized and inside the workspace. Symlink components, conflicting output paths, malformed command results, excessive output, and unsupported exit codes are rejected.

The output is a bounded JSON validation result. Success proves configuration validity for those input bytes, not Android execution, wallet compatibility, or physical-device readiness. The root CI workflow separately exercises unit tests, packaging, and the fixture app.
