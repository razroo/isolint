import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/lint/config.js";
import { runLint } from "../src/lint/runner.js";
import { PERFORMANCE_RULES } from "../src/lint/rules/performance.js";
import { computeFixes } from "../src/lint/fix.js";
import { MockProvider } from "../src/providers/mock.js";

const cfg = { ...DEFAULT_CONFIG };

async function perfLint(source: string, file = "modes/test.md") {
  return runLint([{ rel_path: file, source }], cfg, { rules: PERFORMANCE_RULES });
}

describe("performance preset", () => {
  it("runs through config.extends = [performance]", async () => {
    const source = [
      "## Intake",
      "",
      "Validate the input schema before saving the result.",
      "",
      "## Output",
      "",
      "Validate the input schema before saving the result.",
    ].join("\n");

    const report = await runLint(
      [{ rel_path: "modes/test.md", source }],
      { ...DEFAULT_CONFIG, extends: ["performance"] },
    );

    assert.ok(report.findings.some((f) => f.rule_id === "perf-repeated-instruction-block"));
  });
});

describe("performance rules", () => {
  it("flags repeated instruction blocks across sections", async () => {
    const source = [
      "## Intake",
      "",
      "Validate the input schema before saving the result.",
      "",
      "## Output",
      "",
      "Validate the input schema before saving the result.",
    ].join("\n");
    const report = await perfLint(source);
    assert.ok(report.findings.some((f) => f.rule_id === "perf-repeated-instruction-block"));
  });

  it("flags examples that outweigh the task definition", async () => {
    const example = Array.from(
      { length: 18 },
      () => "Example rows show every field, every edge case, and every alternative phrasing in full detail.",
    ).join(" ");
    const source = [
      "## Task",
      "",
      "Classify the ticket and return JSON.",
      "",
      "## Example",
      "",
      example,
    ].join("\n");
    const report = await perfLint(source);
    assert.ok(report.findings.some((f) => f.rule_id === "perf-example-heavy-section"));
  });

  it("flags duplicated output requirements", async () => {
    const source = [
      "## Step 1",
      "",
      "Return JSON with fields `name` and `score`.",
      "",
      "## Step 2",
      "",
      "Return JSON with fields `name` and `score`.",
    ].join("\n");
    const report = await perfLint(source);
    assert.ok(report.findings.some((f) => f.rule_id === "perf-duplicated-output-requirement"));
  });

  it("flags later steps that restate prior steps", async () => {
    const source = [
      "## Step 1",
      "",
      "Classify the ticket into one label, using the input message and the policy guide to choose the single best category.",
      "",
      "## Step 2",
      "",
      "Classify the ticket into one label, using the input message and the policy guide to choose the single best category.",
    ].join("\n");
    const report = await perfLint(source);
    assert.ok(report.findings.some((f) => f.rule_id === "perf-step-restates-prior-step"));
  });

  it("flags large prose sections with weak operational value", async () => {
    const filler = Array.from(
      { length: 8 },
      () => "This background section offers broad context, narrative framing, historical notes, and extra commentary about the surrounding environment.",
    ).join(" ");
    const source = [
      "## Guidance",
      "",
      filler,
    ].join("\n");
    const report = await perfLint(source);
    assert.ok(report.findings.some((f) => f.rule_id === "perf-low-value-prose-section"));
  });

  it("flags redundant prose when a nearby schema already defines the contract", async () => {
    const source = [
      "## Output",
      "",
      "Return JSON with fields `title`, `company`, and `score`.",
      "",
      "- `title`: string",
      "- `company`: string",
      "- `score`: number",
    ].join("\n");
    const report = await perfLint(source);
    assert.ok(report.findings.some((f) => f.rule_id === "perf-redundant-schema-prose"));
  });

  it("flags structured output requests that also ask for explanation", async () => {
    const source = "Return JSON with fields `title` and `score`, and explain why you chose the score.";
    const report = await perfLint(source);
    assert.ok(report.findings.some((f) => f.rule_id === "perf-structured-output-explanation"));
  });

  it("flags unnecessary tone instructions on structured outputs", async () => {
    const source = "Return JSON in a friendly, conversational tone.";
    const report = await perfLint(source);
    assert.ok(report.findings.some((f) => f.rule_id === "perf-style-tone-overhead"));
  });

  it("deterministically fixes trailing tone/style overhead when the tone phrase is a suffix", async () => {
    const source = "Return JSON in a friendly, conversational tone.";
    const report = await perfLint(source);
    const findings = report.findings.filter((f) => f.rule_id === "perf-style-tone-overhead");
    const fixReport = await computeFixes(
      [{ rel_path: "modes/test.md", source }],
      findings,
      { config: { ...DEFAULT_CONFIG, extends: ["recommended", "performance"] } },
    );
    assert.equal(fixReport.files[0].fixed, "Return JSON.");
  });

  it("uses LLM rewrites for performance findings when the performance preset is enabled", async () => {
    const source = [
      "## Step 1",
      "",
      "Return JSON with fields `name` and `score`.",
      "",
      "## Step 2",
      "",
      "Return JSON with fields `name` and `score`.",
    ].join("\n");
    const report = await perfLint(source);
    const findings = report.findings.filter((f) => f.rule_id === "perf-duplicated-output-requirement");
    assert.equal(findings.length, 1);
    const model = new MockProvider("perf-rewriter", () => "Use the existing JSON format from Step 1.");
    const fixReport = await computeFixes(
      [{ rel_path: "modes/test.md", source }],
      findings,
      {
        use_llm: true,
        model,
        config: { ...DEFAULT_CONFIG, extends: ["recommended", "performance"] },
      },
    );
    assert.ok(fixReport.files[0].fixed.includes("Use the existing JSON format from Step 1."));
  });
});
