import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runLint } from "../src/lint/runner.js";
import { DETERMINISTIC_RULES } from "../src/lint/rules/deterministic.js";
import { computeFixes, writeFiles } from "../src/lint/fix.js";
import { parseSuppressions, applySuppressions } from "../src/lint/suppressions.js";
import { globToRegExp } from "../src/lint/scanner.js";
import { unifiedDiff } from "../src/lint/report.js";
import { DEFAULT_CONFIG } from "../src/lint/config.js";
import { MockProvider } from "../src/providers/mock.js";
import type { LintFinding } from "../src/lint/types.js";

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

  it("does not flag clean prose", async () => {
    const r = await lint("Return a JSON object with a `name` field (string) and a `score` field (0..1).");
    assert.equal(r.findings.length, 0);
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
