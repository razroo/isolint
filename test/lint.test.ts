import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runLint } from "../src/lint/runner.js";
import { DETERMINISTIC_RULES } from "../src/lint/rules/deterministic.js";
import { computeFixes, writeFiles } from "../src/lint/fix.js";
import { parseSuppressions, applySuppressions } from "../src/lint/suppressions.js";
import { globToRegExp } from "../src/lint/scanner.js";
import { unifiedDiff } from "../src/lint/report.js";
import { DEFAULT_CONFIG } from "../src/lint/config.js";
import { compileCustomRules } from "../src/lint/rules/custom.js";
import { tokenizeSentences } from "../src/lint/sentences.js";
import { validateRewrite } from "../src/lint/validate-rewrite.js";
import { MockProvider } from "../src/providers/mock.js";
import type { CustomRuleSpec, LintFinding, ResolvedConfig } from "../src/lint/types.js";

const cfg = { ...DEFAULT_CONFIG };

async function lint(source: string, file = "test.md") {
  return runLint([{ rel_path: file, source }], cfg, { rules: DETERMINISTIC_RULES });
}

describe("deterministic rules", () => {
  it("flags soft imperatives", async () => {
    const r = await lint("You should do X.");
    const ids = r.findings.map((f) => f.rule_id);
    assert.ok(ids.includes("soft-imperative"));
  });

  it("flags vague quantifiers", async () => {
    const r = await lint("Run some checks before saving.");
    assert.ok(r.findings.some((f) => f.rule_id === "vague-quantifier"));
  });

  it("flags taste words including JobForge's banned list", async () => {
    const r = await lint("Be creative and passionate. Leveraged cutting-edge tech.");
    const ids = r.findings.filter((f) => f.rule_id === "taste-word").map((f) => f.snippet.toLowerCase());
    assert.ok(ids.includes("creative"));
    assert.ok(ids.includes("passionate"));
    assert.ok(ids.includes("leveraged"));
    assert.ok(ids.includes("cutting-edge"));
  });

  it("flags trailing etc", async () => {
    const r = await lint("Classify as A, B, C, etc.");
    assert.ok(r.findings.some((f) => f.rule_id === "trailing-etc"));
  });

  it("flags implicit conditionals", async () => {
    const r = await lint("Emit a summary when relevant.");
    assert.ok(r.findings.some((f) => f.rule_id === "implicit-conditional"));
  });

  it("flags double negation", async () => {
    const r = await lint("Don't forget to not skip this step.");
    assert.ok(r.findings.some((f) => f.rule_id === "double-negation"));
  });

  it("flags nested conditionals", async () => {
    const r = await lint(
      "If the score is high, apply; unless the role is on-site, except when the comp is above target, when override.",
    );
    assert.ok(r.findings.some((f) => f.rule_id === "nested-conditional"));
  });

  it("ignores code fences", async () => {
    const r = await lint("```\nsome should could might\n```\nOK here.");
    assert.equal(r.findings.length, 0);
  });

  it("ignores inline code", async () => {
    const r = await lint("Use the `some` helper.");
    assert.equal(r.findings.length, 0);
  });

  it("ignores HTML comments", async () => {
    const r = await lint("<!-- you should NEVER leverage this -->");
    assert.equal(r.findings.length, 0);
  });

  it("ignores short double-quoted phrases (words being named, not used)", async () => {
    const src = `Avoid AI-hallmark words: "leveraged", "utilized", "cutting-edge", "passionate".`;
    const r = await lint(src);
    assert.equal(
      r.findings.filter((f) => f.rule_id === "taste-word").length,
      0,
      "quoted banned-word examples should not self-trigger",
    );
  });

  it("ignores curly-quoted phrases", async () => {
    const src = `Never use \u201cleveraged\u201d or \u201ccutting-edge\u201d.`;
    const r = await lint(src);
    assert.equal(r.findings.filter((f) => f.rule_id === "taste-word").length, 0);
  });

  it("still flags unquoted taste words on the same line", async () => {
    const src = `Avoid "leveraged" but be creative.`;
    const r = await lint(src);
    const taste = r.findings.filter((f) => f.rule_id === "taste-word").map((f) => f.snippet);
    assert.deepEqual(taste, ["creative"]);
  });

  it("still flags words inside long quoted directives (>40 chars)", async () => {
    const src = `Prompt the model with: "be creative and leverage cutting-edge approaches to engage users".`;
    const r = await lint(src);
    assert.ok(r.findings.some((f) => f.rule_id === "taste-word"));
  });

  it("does not flag soft-imperatives inside questions", async () => {
    const src = "What story should they tell in the interview?";
    const r = await lint(src);
    assert.equal(r.findings.filter((f) => f.rule_id === "soft-imperative").length, 0);
  });

  it("still flags soft-imperatives in declarative sentences on the same line", async () => {
    const src = "You should follow the spec. What approach should they pick?";
    const r = await lint(src);
    const hits = r.findings.filter((f) => f.rule_id === "soft-imperative");
    assert.equal(hits.length, 1, "only the declarative 'should' should flag");
    assert.equal(hits[0].snippet.toLowerCase(), "should");
  });

  it("skips YAML frontmatter", async () => {
    const src = ["---", "description: use creative phrasing", "model: claude-3", "---", "", "Real prose here."].join("\n");
    const r = await lint(src);
    assert.equal(r.findings.length, 0, "frontmatter content should be skipped");
  });

  it("skips TOML frontmatter", async () => {
    const src = ["+++", 'description = "be passionate and creative"', "+++", "", "Clean prose."].join("\n");
    const r = await lint(src);
    assert.equal(r.findings.length, 0);
  });

  it("does not skip a --- divider that isn't a frontmatter fence", async () => {
    const src = ["# Heading", "", "Body text with creative word.", "", "---", "", "More text."].join("\n");
    const r = await lint(src);
    assert.ok(r.findings.some((f) => f.rule_id === "taste-word"));
  });

  it("flags placeholder-leftover keywords", async () => {
    const r = await lint("TODO: write the actual prompt. FIXME before ship.");
    const ids = r.findings.filter((f) => f.rule_id === "placeholder-leftover").map((f) => f.snippet);
    assert.ok(ids.includes("TODO"));
    assert.ok(ids.includes("FIXME"));
  });

  it("flags angle-bracket placeholders", async () => {
    const r = await lint("Greet the user with <insert name>.");
    assert.ok(r.findings.some((f) => f.rule_id === "placeholder-leftover" && f.snippet.includes("insert name")));
  });

  it("flags square-bracket placeholders", async () => {
    const r = await lint("Say [INSERT GREETING] to the candidate.");
    assert.ok(r.findings.some((f) => f.rule_id === "placeholder-leftover" && f.snippet === "[INSERT GREETING]"));
  });

  it("does not flag lowercase 'todo' as placeholder", async () => {
    const r = await lint("The todo list has three items.");
    assert.equal(r.findings.filter((f) => f.rule_id === "placeholder-leftover").length, 0);
  });

  it("does not flag handlebars by default", async () => {
    const r = await lint("Render {{user.name}} in the greeting.");
    assert.equal(r.findings.filter((f) => f.rule_id === "placeholder-leftover").length, 0);
  });

  it("flags handlebars when include_handlebars is enabled", async () => {
    const customCfg = {
      ...DEFAULT_CONFIG,
      options: { "placeholder-leftover.include_handlebars": true },
    };
    const r = await runLint(
      [{ rel_path: "test.md", source: "Render {{user.name}} in the greeting." }],
      customCfg,
      { rules: DETERMINISTIC_RULES },
    );
    assert.ok(r.findings.some((f) => f.rule_id === "placeholder-leftover" && f.snippet === "{{user.name}}"));
  });

  it("does not flag clean prose", async () => {
    const r = await lint("Return a JSON object with a `name` field (string) and a `score` field (0..1).");
    assert.equal(r.findings.length, 0);
  });
});

describe("sentence tokenizer", () => {
  it("doesn't split on abbreviations (e.g., i.e., etc.)", () => {
    const src = "Evaluate the role on every dimension (e.g., seniority, comp, scope). Then score it.";
    const sents = tokenizeSentences(src, []);
    assert.equal(sents.length, 2, "two sentences — 'e.g.' must not split");
    assert.ok(sents[0].text.includes("e.g."));
    assert.ok(sents[1].text.startsWith("Then score"));
  });

  it("doesn't split on filenames (cv.md, plan.json)", () => {
    const src = "Read cv.md and plan.json. Validate both.";
    const sents = tokenizeSentences(src, []);
    assert.equal(sents.length, 2);
    assert.equal(sents[0].text, "Read cv.md and plan.json.");
  });

  it("doesn't split on URLs", () => {
    const src = "See https://example.com/a/b for the spec. Use it to verify.";
    const sents = tokenizeSentences(src, []);
    assert.equal(sents.length, 2);
    assert.ok(sents[0].text.includes("https://example.com/a/b"));
  });

  it("doesn't split on decimals", () => {
    const src = "If the score is 3.5 or greater, apply the rule. Otherwise, skip.";
    const sents = tokenizeSentences(src, []);
    assert.equal(sents.length, 2);
    assert.ok(sents[0].text.includes("3.5"));
  });

  it("treats ellipsis as a single terminator", () => {
    const src = "Wait... Then continue to the next step.";
    const sents = tokenizeSentences(src, []);
    assert.equal(sents.length, 2);
    assert.equal(sents[0].text, "Wait...");
  });

  it("breaks at blank lines (paragraph boundary)", () => {
    const src = "First part\n\nSecond part";
    const sents = tokenizeSentences(src, []);
    assert.equal(sents.length, 2);
  });

  it("annotates findings with containing sentence", async () => {
    const src = "You should always validate input before saving.";
    const r = await lint(src);
    const hit = r.findings.find((f) => f.rule_id === "soft-imperative");
    assert.ok(hit);
    assert.equal(hit!.sentence, "You should always validate input before saving.");
  });
});

describe("section awareness", () => {
  it("attaches section name to findings", async () => {
    const src = ["# My Harness", "", "## Step 3 — Classify", "", "You should always validate."].join("\n");
    const r = await lint(src);
    const hit = r.findings.find((f) => f.rule_id === "soft-imperative");
    assert.ok(hit);
    assert.equal(hit!.section, "Step 3 — Classify");
  });

  it("respects section_severity overrides", async () => {
    const customCfg = {
      ...DEFAULT_CONFIG,
      section_severity: { Examples: "off" as const },
    };
    const src = ["## Examples", "", "bad creative passionate.", "", "## Step 1", "", "be creative."].join("\n");
    const r = await runLint([{ rel_path: "t.md", source: src }], customCfg);
    const hits = r.findings.filter((f) => f.rule_id === "taste-word");
    assert.equal(hits.length, 1, "only the Step 1 finding should survive");
    assert.equal(hits[0].section, "Step 1");
  });

  it("section_severity downgrade changes severity", async () => {
    const customCfg = {
      ...DEFAULT_CONFIG,
      section_severity: { Notes: "info" as const },
    };
    const src = ["## Notes", "", "Be creative here."].join("\n");
    const r = await runLint([{ rel_path: "t.md", source: src }], customCfg);
    const hit = r.findings.find((f) => f.rule_id === "taste-word");
    assert.ok(hit);
    assert.equal(hit!.severity, "info");
  });
});

describe("blockquote skip span", () => {
  it("skips contents of > blockquotes", async () => {
    const src = [
      "# Harness",
      "",
      "> Example prose from the candidate:",
      "> I am a passionate engineer who leveraged cutting-edge tools.",
      "",
      "Real instruction: classify the role.",
    ].join("\n");
    const r = await lint(src);
    assert.equal(r.findings.filter((f) => f.rule_id === "taste-word").length, 0);
  });
});

describe("output-contract rules", () => {
  it("flags 'return JSON' with no example or schema nearby", async () => {
    const r = await lint("Step 3: return JSON with the extracted fields. Then stop.");
    assert.ok(r.findings.some((f) => f.rule_id === "output-format-no-example"));
  });

  it("accepts 'return JSON' followed by a fenced example", async () => {
    const src = [
      "Step 3: return JSON like this:",
      "",
      "```json",
      '{ "score": 0.9, "reason": "match" }',
      "```",
    ].join("\n");
    const r = await lint(src);
    assert.equal(r.findings.filter((f) => f.rule_id === "output-format-no-example").length, 0);
  });

  it("accepts 'return JSON' followed by a bullet list of fields", async () => {
    const src = [
      "Return JSON with these fields:",
      "",
      "- `score` (number, 0..1)",
      "- `reason` (string)",
      "- `tags` (string[])",
    ].join("\n");
    const r = await lint(src);
    assert.equal(r.findings.filter((f) => f.rule_id === "output-format-no-example").length, 0);
  });

  it("flags a gap in numbered steps", async () => {
    const src = ["1. Read file", "2. Parse JSON", "4. Return result"].join("\n");
    const r = await lint(src);
    const hit = r.findings.find((f) => f.rule_id === "numbered-step-gap");
    assert.ok(hit);
    assert.ok(hit!.message.includes("from 2 to 4"));
  });

  it("does not flag sequential numbered steps", async () => {
    const src = ["1. Read", "2. Parse", "3. Return"].join("\n");
    const r = await lint(src);
    assert.equal(r.findings.filter((f) => f.rule_id === "numbered-step-gap").length, 0);
  });

  it("flags step body that doesn't open with a verb (in harness paths)", async () => {
    const src = ["## Step 1 — Classification", "", "Configuration of the role goes here."].join("\n");
    const r = await lint(src, "modes/classify.md");
    assert.ok(r.findings.some((f) => f.rule_id === "step-without-verb"));
  });

  it("accepts step body that opens with a verb", async () => {
    const src = ["## Step 1 — Classify", "", "Classify the role as remote or onsite."].join("\n");
    const r = await lint(src, "modes/classify.md");
    assert.equal(r.findings.filter((f) => f.rule_id === "step-without-verb").length, 0);
  });

  it("step-without-verb skips files outside harness paths", async () => {
    const src = ["## Step 1 — X", "", "Description text here."].join("\n");
    const r = await lint(src, "README.md");
    assert.equal(r.findings.filter((f) => f.rule_id === "step-without-verb").length, 0);
  });
});

describe("rewrite validation", () => {
  const cfg: ResolvedConfig = { ...DEFAULT_CONFIG };
  const rules = DETERMINISTIC_RULES;

  it("accepts a valid rewrite that drops the violation", () => {
    const finding: LintFinding = {
      rule_id: "taste-word",
      severity: "warn",
      file: "t.md",
      range: { line: 1, column: 1 },
      message: "be creative is taste-based",
      snippet: "be creative",
      sentence: "You should be creative.",
    };
    const problems = validateRewrite(
      "You should be creative.",
      "You MUST list three options.",
      [finding],
      cfg,
      rules,
    );
    assert.deepEqual(problems.filter((p) => !p.includes("changed")), []);
  });

  it("rejects a rewrite that still violates the rule", () => {
    const finding: LintFinding = {
      rule_id: "taste-word",
      severity: "warn",
      file: "t.md",
      range: { line: 1, column: 1 },
      message: "creative is taste-based",
      snippet: "be creative",
      sentence: "You should be creative.",
    };
    const problems = validateRewrite(
      "You should be creative.",
      "Be creative and engaging.",
      [finding],
      cfg,
      rules,
    );
    assert.ok(problems.some((p) => p.includes("still violates taste-word")));
  });

  it("rejects a rewrite that introduces a new violation", () => {
    const finding: LintFinding = {
      rule_id: "vague-quantifier",
      severity: "warn",
      file: "t.md",
      range: { line: 1, column: 1 },
      message: "some is vague",
      snippet: "some items",
      sentence: "Return some items.",
    };
    // New rewrite drops "some" (good) but adds "creative" (new violation).
    const problems = validateRewrite(
      "Return some items.",
      "Return 5 creative items.",
      [finding],
      cfg,
      rules,
    );
    assert.ok(problems.some((p) => p.includes("introduces new taste-word")));
  });

  it("rejects a rewrite that changes markdown structure", () => {
    const finding: LintFinding = {
      rule_id: "soft-imperative",
      severity: "warn",
      file: "t.md",
      range: { line: 1, column: 1 },
      message: "should is soft",
      snippet: "should",
      sentence: "- **Label** You should X.",
    };
    // Drops the bold markers — structure mismatch.
    const problems = validateRewrite(
      "- **Label** You should X.",
      "- Label You MUST X.",
      [finding],
      cfg,
      rules,
    );
    assert.ok(problems.some((p) => p.includes("bold-markers")));
  });
});

describe("custom rules", () => {
  it("fires on a user-defined pattern", async () => {
    const customCfg = {
      ...DEFAULT_CONFIG,
      custom_rules: [
        { id: "no-acme", pattern: "\\bAcme\\s+Corp\\b", message: "Use 'ACME Inc'" } as CustomRuleSpec,
      ],
    };
    const r = await runLint([{ rel_path: "t.md", source: "Contact Acme Corp today." }], customCfg);
    const hit = r.findings.find((f) => f.rule_id === "no-acme");
    assert.ok(hit, "custom rule should fire");
    assert.equal(hit!.snippet, "Acme Corp");
    assert.equal(hit!.severity, "warn");
  });

  it("respects the skip_spans (backticks, quotes, frontmatter)", async () => {
    const customCfg = {
      ...DEFAULT_CONFIG,
      custom_rules: [
        { id: "no-foo", pattern: "\\bfoo\\b", message: "bad" } as CustomRuleSpec,
      ],
    };
    const src = ["---", "title: foo", "---", "", "`foo`", "", "foo is bad here."].join("\n");
    const r = await runLint([{ rel_path: "t.md", source: src }], customCfg);
    const hits = r.findings.filter((f) => f.rule_id === "no-foo");
    assert.equal(hits.length, 1, "only the bare 'foo' should trigger");
  });

  it("honors custom severity and honors rules[<id>] = off", async () => {
    const customCfg = {
      ...DEFAULT_CONFIG,
      rules: { "no-error": "off" as const },
      custom_rules: [
        { id: "no-error", pattern: "\\berror\\b", severity: "error" as const, message: "no" } as CustomRuleSpec,
      ],
    };
    const r = await runLint([{ rel_path: "t.md", source: "this is an error" }], customCfg);
    assert.equal(r.findings.filter((f) => f.rule_id === "no-error").length, 0);
  });

  it("drops invalid specs without throwing", () => {
    const reserved = new Set<string>(["taste-word"]);
    const specs: CustomRuleSpec[] = [
      { id: "taste-word", pattern: "x", message: "collides" },
      { id: "", pattern: "x", message: "missing id" } as CustomRuleSpec,
      { id: "bad-regex", pattern: "(", message: "unbalanced" },
      { id: "dup", pattern: "a", message: "first" },
      { id: "dup", pattern: "b", message: "second" },
      { id: "ok", pattern: "\\bgo\\b", message: "fine" },
    ];
    const rules = compileCustomRules(specs, reserved);
    const ids = rules.map((r) => r.id);
    assert.deepEqual(ids, ["dup", "ok"], "only the valid, first-seen specs compile");
  });
});

describe("suppressions", () => {
  it("suppresses next line with all rules", () => {
    const src = [
      "Normal line.",
      "<!-- isomodel-lint-disable-next-line -->",
      "This is creative and passionate.",
      "Back to normal.",
    ].join("\n");
    const sups = parseSuppressions(src);
    assert.equal(sups.length, 1);
    assert.equal(sups[0].start_line, 3);
    assert.equal(sups[0].end_line, 3);
    assert.equal(sups[0].rule_ids, null);
  });

  it("suppresses next line with specific rules", () => {
    const src = "<!-- isomodel-lint-disable-next-line taste-word -->\nbad creative text";
    const sups = parseSuppressions(src);
    assert.deepEqual([...sups[0].rule_ids!], ["taste-word"]);
  });

  it("applies block suppressions", async () => {
    const src = [
      "<!-- isomodel-lint-disable taste-word -->",
      "creative passionate",
      "<!-- isomodel-lint-enable -->",
      "creative again",
    ].join("\n");
    const r = await runLint([{ rel_path: "t.md", source: src }], cfg, { rules: DETERMINISTIC_RULES });
    const tasteFindings = r.findings.filter((f) => f.rule_id === "taste-word");
    assert.equal(tasteFindings.length, 1);
    assert.equal(tasteFindings[0].range.line, 4);
  });

  it("applySuppressions matches rule ids", () => {
    const onLine2: LintFinding[] = [
      { rule_id: "taste-word", severity: "warn", file: "a.md", range: { line: 2, column: 1 }, message: "x", snippet: "creative" },
    ];
    const suppressedAll = applySuppressions(
      onLine2,
      new Map([["a.md", "<!-- isomodel-lint-disable-next-line -->\ncreative"]]),
    );
    assert.equal(suppressedAll.length, 0, "disable-next-line with no ids suppresses all rules");

    const notSuppressed = applySuppressions(
      onLine2,
      new Map([["a.md", "<!-- isomodel-lint-disable-next-line other-rule -->\ncreative"]]),
    );
    assert.equal(notSuppressed.length, 1, "disable-next-line with other rule id does not suppress taste-word");
  });
});

describe("glob matcher", () => {
  it("matches ** across segments", () => {
    const re = globToRegExp("node_modules/**");
    assert.ok(re.test("node_modules/foo/bar"));
    assert.ok(re.test("node_modules/"));
    assert.ok(!re.test("src/node_modules/foo"));
  });

  it("matches * within a segment", () => {
    const re = globToRegExp("*.min.md");
    assert.ok(re.test("foo.min.md"));
    assert.ok(!re.test("foo/bar.min.md"));
  });
});

describe("fix engine", () => {
  it("applies deterministic fixes in reverse offset order", async () => {
    const source = "alpha beta gamma";
    const findings: LintFinding[] = [
      {
        rule_id: "r",
        severity: "warn",
        file: "x.md",
        range: { line: 1, column: 1 },
        message: "m",
        snippet: "alpha",
        fix: { start: 0, end: 5, replacement: "A", description: "" },
      },
      {
        rule_id: "r",
        severity: "warn",
        file: "x.md",
        range: { line: 1, column: 12 },
        message: "m",
        snippet: "gamma",
        fix: { start: 11, end: 16, replacement: "G", description: "" },
      },
    ];
    const report = await computeFixes(
      [{ rel_path: "x.md", source }],
      findings,
      {},
    );
    assert.equal(report.files[0].fixed, "A beta G");
    assert.equal(report.applied_total, 2);
  });

  it("uses LLM rewrites when use_llm=true", async () => {
    const source = "Be creative about this.";
    const findings: LintFinding[] = [
      {
        rule_id: "taste-word",
        severity: "warn",
        file: "x.md",
        range: { line: 1, column: 4, end_line: 1, end_column: 12 },
        message: "taste",
        snippet: "creative",
        llm_fixable: true,
      },
    ];
    const model = new MockProvider("rewriter", () => "specific");
    const report = await computeFixes(
      [{ rel_path: "x.md", source }],
      findings,
      { use_llm: true, model },
    );
    assert.equal(report.files[0].fixed, "Be specific about this.");
  });

  it("produces a unified diff", () => {
    const diff = unifiedDiff("a.md", "line one\nline two\nline three\n", "line one\nLINE TWO\nline three\n");
    assert.ok(diff.includes("--- a/a.md"));
    assert.ok(diff.includes("-line two"));
    assert.ok(diff.includes("+LINE TWO"));
  });

  it("writeFiles only writes changed files", async () => {
    const tmp = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const dir = await tmp.mkdtemp(path.join(os.tmpdir(), "isomodel-"));
    const file = path.join(dir, "x.md");
    await tmp.writeFile(file, "alpha");
    const report = {
      files: [
        {
          rel_path: "x.md",
          abs_path: file,
          original: "alpha",
          fixed: "beta",
          applied: 1,
          skipped: 0,
          changed: true,
        },
      ],
      applied_total: 1,
      skipped_total: 0,
    };
    const n = writeFiles(report, dir);
    assert.equal(n, 1);
    assert.equal(await tmp.readFile(file, "utf8"), "beta");
  });
});
