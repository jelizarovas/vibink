import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the public Codex plugin contains a complete Vibink skill", async () => {
  const [packageJson, manifest, skill, agent] = await Promise.all([
    readFile(new URL("package.json", root), "utf8").then(JSON.parse),
    readFile(new URL("plugins/vibink/.codex-plugin/plugin.json", root), "utf8").then(JSON.parse),
    readFile(new URL("plugins/vibink/skills/vibink/SKILL.md", root), "utf8"),
    readFile(new URL("plugins/vibink/skills/vibink/agents/openai.yaml", root), "utf8"),
  ]);

  assert.equal(manifest.name, "vibink");
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(Object.hasOwn(manifest, "mcpServers"), false);
  assert.equal(manifest.author.name, "Vibink contributors");
  assert.match(manifest.homepage, /^https:\/\//);
  assert.match(manifest.repository, /^https:\/\//);
  assert.equal(Array.isArray(manifest.interface.defaultPrompt), true);
  assert.equal(manifest.interface.defaultPrompt.length <= 3, true);
  assert.equal(manifest.interface.defaultPrompt.every((prompt) => prompt.length <= 128), true);

  assert.match(skill, /^---\r?\nname: vibink\r?\ndescription: .+\r?\n---/);
  assert.doesNotMatch(skill, /\[TODO:/);
  for (const tool of [
    "vibink_connection_info",
    "vibink_get_state",
    "vibink_begin_request",
    "vibink_update_request",
    "vibink_complete_task",
  ]) {
    assert.match(skill, new RegExp(`\\b${tool}\\b`));
  }

  assert.match(agent, /display_name: "Vibink"/);
  assert.match(agent, /default_prompt: "Use \$vibink /);
});

test("the release page points to the matching public release and keeps Vibink branding", async () => {
  const [packageJson, page, styles, pageMark, extensionMark] = await Promise.all([
    readFile(new URL("package.json", root), "utf8").then(JSON.parse),
    readFile(new URL("docs/index.html", root), "utf8"),
    readFile(new URL("docs/site.css", root), "utf8"),
    readFile(new URL("docs/vibink-mark.svg", root), "utf8"),
    readFile(new URL("extension/vibink-mark.svg", root), "utf8"),
  ]);
  const escapedVersion = packageJson.version.replaceAll(".", "\\.");
  assert.match(page, new RegExp(`releases/download/v${escapedVersion}/vibink-${escapedVersion}\\.zip`));
  assert.match(page, /\$skill-installer Install the skill from/);
  assert.match(page, /github\.com\/jelizarovas\/vibink\/tree\/main\/plugins\/vibink\/skills\/vibink/);
  assert.match(page, /rel="icon" href="vibink-mark\.svg" type="image\/svg\+xml"/);
  assert.match(page, /<img class="mark" src="vibink-mark\.svg" alt="">/);
  assert.equal(pageMark, extensionMark);
  assert.match(styles, /--accent: #a77cff/);
  assert.match(styles, /--accent-strong: #8a55ff/);
  assert.match(styles, /rgba\(133, 78, 235, 0\.25\)/);
  assert.doesNotMatch(page, /0000|192\.168\.0\.9|arnashonda|arnasj\.chatgpt\.site/i);
});
