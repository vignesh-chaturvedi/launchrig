function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isArtifactSize(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateIdentity(identity, label) {
  if (!isArtifactSize(identity?.size) || !isSha256(identity?.sha256)) {
    throw new Error(label + " must declare a positive size and lowercase SHA-256 digest.");
  }
}

export function classifyArtifact(actual, expected, contract) {
  validateIdentity(expected, contract);
  validateIdentity(actual, "Built artifact metadata");

  return {
    status: actual.size === expected.size && actual.sha256 === expected.sha256 ? "validated" : "candidate",
    contract,
    expected: { size: expected.size, sha256: expected.sha256 },
    actual: { size: actual.size, sha256: actual.sha256 },
  };
}

export function candidateArtifactName(artifactName, sha256) {
  if (typeof artifactName !== "string" || !artifactName.endsWith(".apk")) {
    throw new Error("Candidate base artifact name must end with .apk.");
  }
  if (!isSha256(sha256)) {
    throw new Error("Candidate artifact name requires a lowercase SHA-256 digest.");
  }
  return artifactName.slice(0, -4) + ".candidate-" + sha256 + ".apk";
}

export function validateArtifact(actual, expected, contract) {
  const classification = classifyArtifact(actual, expected, contract);

  const mismatches = [];
  if (classification.actual.size !== classification.expected.size) {
    mismatches.push("size " + actual.size + " (expected " + expected.size + ")");
  }
  if (classification.actual.sha256 !== classification.expected.sha256) {
    mismatches.push("sha256 " + actual.sha256 + " (expected " + expected.sha256 + ")");
  }
  if (mismatches.length > 0) {
    throw new Error(
      "Built artifact does not match " +
        contract +
        ": " +
        mismatches.join(", ") +
        ". The stable artifact was not replaced.",
    );
  }

  return {
    status: "validated",
    contract,
    size: classification.actual.size,
    sha256: classification.actual.sha256,
  };
}
