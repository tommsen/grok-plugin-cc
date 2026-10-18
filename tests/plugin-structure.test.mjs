import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { PLUGIN_ROOT, REPO_ROOT } from "./helpers.mjs";

const EXPECTED_COMMANDS = [
  "adversarial-review",
  "ask",
  "cancel",
  "rescue",
  "result",
  "review",
  "setup",
  "status",
  "test-gaps",
  "transfer"
];

function parseFrontmatter(filePath) {
  // Windows checkouts with core.autocrlf=true have CRLF line endings.
  const content = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${filePath} must start with YAML frontmatter`);
  const fields = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0 && !line.startsWith(" ") && !line.startsWith("-")) {
      fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return { fields, body: content.slice(match[0].length) };
}

test("all expected commands exist with description frontmatter", () => {
  for (const command of EXPECTED_COMMANDS) {
    const filePath = path.join(PLUGIN_ROOT, "commands", `${command}.md`);
    assert.ok(fs.existsSync(filePath), `missing command: ${command}`);
    const { fields } = parseFrontmatter(filePath);
    assert.ok(fields.description, `${command}.md needs a description`);
  }
});

test("companion-invoking commands reference the companion script", () => {
  for (const command of EXPECTED_COMMANDS) {
    const { body } = parseFrontmatter(path.join(PLUGIN_ROOT, "commands", `${command}.md`));
    assert.match(body, /grok-companion\.mjs/, `${command}.md should invoke the companion script`);
  }
});

test("plugin.json and marketplace.json agree on name and version", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"), "utf8")
  );

  const entry = marketplace.plugins.find((candidate) => candidate.name === plugin.name);
  assert.ok(entry, "marketplace must list the grok plugin");
  assert.equal(entry.version, plugin.version);
  assert.equal(entry.source, "./plugins/grok");
  assert.equal(marketplace.metadata.version, plugin.version);
});

test("hooks.json wires SessionStart and SessionEnd to the lifecycle hook", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
  for (const event of ["SessionStart", "SessionEnd"]) {
    const entries = hooks.hooks[event];
    assert.ok(Array.isArray(entries) && entries.length > 0, `missing ${event} hook`);
    assert.match(entries[0].hooks[0].command, /session-lifecycle-hook\.mjs/);
  }
});

test("review schema is valid JSON with the expected contract", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8")
  );
  assert.deepEqual(schema.required, ["verdict", "summary", "findings", "next_steps"]);
  assert.deepEqual(schema.properties.verdict.enum, ["approve", "needs-attention"]);
});

test("prompt templates carry the placeholders the companion interpolates", () => {
  for (const name of ["review", "adversarial-review", "test-gaps"]) {
    const template = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", `${name}.md`), "utf8");
    for (const placeholder of ["{{TARGET_LABEL}}", "{{USER_FOCUS}}", "{{REVIEW_COLLECTION_GUIDANCE}}", "{{REVIEW_INPUT}}"]) {
      assert.ok(template.includes(placeholder), `${name}.md missing ${placeholder}`);
    }
  }
});

test("every review prompt tells grok to apply the project's own rules", () => {
  for (const name of ["review", "adversarial-review", "test-gaps"]) {
    const template = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", `${name}.md`), "utf8");
    assert.match(template, /<project_rules>[\s\S]*CLAUDE\.md[\s\S]*AGENTS\.md[\s\S]*<\/project_rules>/, `${name}.md needs a project_rules block`);
  }
});

test("test-gaps schema asks for surviving and breaking tests per gap", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "test-gaps-output.schema.json"), "utf8")
  );
  assert.deepEqual(schema.required, ["summary", "gaps"]);
  assert.deepEqual(schema.properties.gaps.items.required, [
    "mutation",
    "file",
    "line",
    "surviving_tests",
    "breaking_tests",
    "confidence",
    "suggested_test"
  ]);
});

// A Claude subagent that only forwards one Bash call cost ~200k Claude tokens
// per rescue (measured 2026-09-27); calling the companion directly costs none.
test("no forwarding subagent ships with the plugin", () => {
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "agents", "grok-rescue.md")), false);
});

test("rescue and ask call the companion directly with a prompt file", () => {
  for (const command of ["rescue", "ask"]) {
    const { fields, body } = parseFrontmatter(path.join(PLUGIN_ROOT, "commands", `${command}.md`));
    assert.doesNotMatch(fields["allowed-tools"] ?? "", /\bAgent\b/, `${command}.md must not route through a subagent`);
    assert.doesNotMatch(body, /subagent_type/, `${command}.md must not route through a subagent`);
    assert.match(body, /grok-companion\.mjs" task/);
    assert.match(body, /--prompt-file/);
  }
});

test("delegate skill tells Claude to call the companion through Bash, read-only by default", () => {
  const skillPath = path.join(PLUGIN_ROOT, "skills", "delegate", "SKILL.md");
  assert.ok(fs.existsSync(skillPath), "missing skills/delegate/SKILL.md");
  const { fields, body } = parseFrontmatter(skillPath);
  assert.equal(fields.name, "delegate");
  assert.ok(fields.description && fields.description.length > 40, "the description decides when Claude loads it");
  assert.match(body, /grok-companion\.mjs" task --prompt-file/);
  assert.match(body, /run_in_background/);
  assert.match(body, /--write/);
  assert.doesNotMatch(body, /subagent_type/);
});

test("rescue and the delegate skill offer the proposal mode", () => {
  const rescue = parseFrontmatter(path.join(PLUGIN_ROOT, "commands", "rescue.md")).body;
  assert.match(rescue, /--propose/);
  assert.match(rescue, /git apply/);
  const skill = parseFrontmatter(path.join(PLUGIN_ROOT, "skills", "delegate", "SKILL.md")).body;
  assert.match(skill, /task --propose --prompt-file/);
  assert.match(skill, /git apply --check/);
});

test("proposal schema and prompt carry the contract the companion relies on", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "proposal-output.schema.json"), "utf8"));
  assert.deepEqual(schema.required, ["summary", "patch", "tests_to_run", "risks"]);
  const template = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "proposal.md"), "utf8");
  assert.ok(template.includes("{{TASK}}"));
  assert.match(template, /<project_rules>[\s\S]*CLAUDE\.md[\s\S]*AGENTS\.md/);
  // Measured 2026-10-18: one real run answered with a progress note and an empty patch.
  assert.match(template, /<grounding_rules>[\s\S]*progress note[\s\S]*empty `patch` is allowed only after/);
});

test("proposal hand-over uses the proposal line, the CRLF-safe apply and the test-command check", () => {
  const rescue = parseFrontmatter(path.join(PLUGIN_ROOT, "commands", "rescue.md")).body;
  const skill = parseFrontmatter(path.join(PLUGIN_ROOT, "skills", "delegate", "SKILL.md")).body;
  // The skill wraps its lines; compare on collapsed whitespace.
  for (const body of [rescue, skill].map((text) => text.replace(/\s+/g, " "))) {
    assert.match(body, /You cannot modify files\. Deliver the complete change as a unified diff in the patch field\./);
    // Apply exactly what the output shows; the flag only when the check needed it.
    assert.match(body, /exactly the command the output shows/);
    assert.match(body, /git apply "<patch file>"/);
    assert.match(body, /--ignore-whitespace/);
    assert.match(body, /check line endings and `git diff`/);
    assert.match(body, /installs, downloads, or writes outside the repository/);
    assert.match(body, /`package\.json` script/);
  }
});

// The prose may mention --write as an opt-in, but no command line Claude would
// copy may carry it: ask is read-only by contract, the delegate skill opt-in only.
function bashBlocks(body) {
  // Fenced blocks may be indented inside list items (SKILL.md).
  return [...body.matchAll(/^[ \t]*```bash\n([\s\S]*?)\n[ \t]*```/gm)].map((match) => match[1]);
}

test("ask never passes --write; the delegate skill command line does not either", () => {
  const ask = parseFrontmatter(path.join(PLUGIN_ROOT, "commands", "ask.md"));
  const askBlocks = bashBlocks(ask.body);
  assert.ok(askBlocks.some((block) => block.includes("grok-companion.mjs\" task")), "ask.md needs a bash block with the task call");
  for (const block of askBlocks) {
    assert.doesNotMatch(block, /--write/, "ask.md bash blocks must not contain --write");
  }

  const skill = parseFrontmatter(path.join(PLUGIN_ROOT, "skills", "delegate", "SKILL.md"));
  const taskLines = bashBlocks(skill.body).flatMap((block) => block.split("\n")).filter((line) => line.includes("grok-companion.mjs\" task"));
  assert.ok(taskLines.length > 0, "SKILL.md needs a bash block with the task call");
  for (const line of taskLines) {
    assert.doesNotMatch(line, /--write/, "the SKILL.md task command line must not contain --write");
  }
});
