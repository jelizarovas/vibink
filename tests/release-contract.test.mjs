import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("release preparation runs tests between static checks and build", async () => {
  const source = await readFile(join(projectRoot, "scripts", "release.mjs"), "utf8");
  const checkIndex = source.indexOf('runNodeScript("check.mjs");');
  const testIndex = source.indexOf("runNpmTest();");
  const buildIndex = source.indexOf('runNodeScript("build.mjs");');

  assert.notEqual(checkIndex, -1, "release preparation must run static checks");
  assert.notEqual(testIndex, -1, "release preparation must run npm test");
  assert.notEqual(buildIndex, -1, "release preparation must run the build");
  assert.ok(checkIndex < testIndex, "npm test must run after static checks");
  assert.ok(testIndex < buildIndex, "npm test must run before the build");
});

test("local publishing refreshes and rechecks remote provenance around packaging", async () => {
  const source = await readFile(join(projectRoot, "scripts", "release.mjs"), "utf8");
  const publishFunction = source.slice(
    source.indexOf("function publishGitHubRelease"),
    source.indexOf("async function run()"),
  );
  const runFunction = source.slice(source.indexOf("async function run()"), source.indexOf("run().catch"));

  const requiredContracts = [
    '"fetch",',
    '"--no-tags",',
    '"origin",',
    '`+refs/tags/${tag}:refs/tags/${tag}`',
    '"+refs/heads/main:refs/remotes/origin/main"',
    '`refs/tags/${tag}^{commit}`',
    '["merge-base", "--is-ancestor", headCommit, "refs/remotes/origin/main"]',
    'process.env.VIBINK_RELEASE_COMMIT || ""',
  ];
  for (const contract of requiredContracts) {
    assert.ok(source.includes(contract), `local release is missing provenance contract: ${contract}`);
  }

  const prePackageCheck = runFunction.indexOf("assertPublishProvenance(newVersion);");
  const packageStart = runFunction.indexOf('runNodeScript("check.mjs");');
  const prePublishCheck = publishFunction.indexOf("assertPublishProvenance(version);");
  const ghCreate = publishFunction.indexOf('spawnSync("gh", args');
  assert.notEqual(prePackageCheck, -1, "publishing must perform a pre-package provenance check");
  assert.notEqual(packageStart, -1, "release preparation must retain its static-check boundary");
  assert.notEqual(prePublishCheck, -1, "publishing must perform a final provenance check");
  assert.notEqual(ghCreate, -1, "publishing must retain the GitHub release invocation");
  assert.ok(
    prePackageCheck < packageStart,
    "publishing must verify freshly fetched provenance before release preparation",
  );
  assert.ok(
    prePublishCheck < ghCreate,
    "publishing must re-fetch and recheck provenance immediately before GitHub release creation",
  );
});

test("release workflow publishes the package job's verified artifact without rebuilding it", async () => {
  const workflow = await readFile(
    join(projectRoot, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const publishJob = workflow.slice(workflow.indexOf("\n  publish:"));

  const requiredContracts = [
    "artifact_name: ${{ steps.artifact.outputs.name }}",
    "artifact_sha256: ${{ steps.artifact.outputs.sha256 }}",
    "commit: ${{ steps.provenance.outputs.commit }}",
    'tag_commit="$(git rev-parse --verify "refs/tags/${RELEASE_TAG}^{commit}")"',
    'git merge-base --is-ancestor "$tag_commit" refs/remotes/origin/main',
    "ref: ${{ needs.package.outputs.commit }}",
    "name: ${{ needs.package.outputs.artifact_name }}",
    "EXPECTED_SHA256: ${{ needs.package.outputs.artifact_sha256 }}",
    'node scripts/verify-package.mjs "$zip_path" extension',
    'tag_commit" != "$EXPECTED_COMMIT"',
    'git merge-base --is-ancestor "$EXPECTED_COMMIT" refs/remotes/origin/main',
    'gh "${release_args[@]}"',
  ];

  for (const contract of requiredContracts) {
    assert.ok(workflow.includes(contract), `release workflow is missing provenance contract: ${contract}`);
  }

  const downloadStep = publishJob.indexOf("Download tested release artifact");
  const verifyStep = publishJob.indexOf("Verify downloaded release artifact");
  const publishStep = publishJob.indexOf("Publish the exact packaged release");
  assert.notEqual(downloadStep, -1, "the publish job must download the package job artifact");
  assert.notEqual(verifyStep, -1, "the publish job must verify the downloaded artifact");
  assert.notEqual(publishStep, -1, "the publish job must publish the verified artifact");
  assert.ok(
    downloadStep < verifyStep,
    "the publish job must download the package job artifact before verifying it",
  );
  assert.ok(
    verifyStep < publishStep,
    "the publish job must verify the downloaded artifact before publication",
  );
  assert.ok(!publishJob.includes("npm ci"), "the publish job must not reinstall or rebuild the package");
  assert.ok(
    !publishJob.includes("node scripts/release.mjs"),
    "the publish job must publish the downloaded package rather than rebuilding it",
  );
});

test("GitHub Actions dependencies use reviewed immutable release commits", async () => {
  const workflows = await Promise.all([
    readFile(join(projectRoot, ".github", "workflows", "ci.yml"), "utf8"),
    readFile(join(projectRoot, ".github", "workflows", "release.yml"), "utf8"),
  ]);
  const requiredPins = [
    "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
    "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
  ];
  const combined = workflows.join("\n");
  for (const pin of requiredPins) {
    assert.ok(combined.includes(pin), `workflow is missing reviewed action pin: ${pin}`);
  }

  for (const workflow of workflows) {
    const actionUses = workflow.split("\n").filter((line) => /uses:\s+actions\//.test(line));
    assert.ok(actionUses.length > 0, "workflow must declare at least one official action");
    for (const actionUse of actionUses) {
      assert.match(
        actionUse,
        /^\s*uses:\s+actions\/[a-z0-9-]+@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+\s*$/,
        `official action must use a full immutable commit with a version comment: ${actionUse}`,
      );
    }
  }
});
