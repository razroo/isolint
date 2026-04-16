/**
 * Tier 2 rules: LLM-assisted. Each rule is implemented as an Isomodel
 * Plan so we reuse the full runtime (schema validation, retries, repair).
 *
 * These are opt-in via --llm or config. They cost tokens. Use them as
 * a secondary pass after deterministic rules.
 */

import { Runtime } from "../../runtime/index.js";
import type { Plan } from "../../schema/plan.js";
import { createLogger } from "../../util/logger.js";
import type { ModelProvider } from "../../providers/types.js";
import type { LintContext, LintFinding, Rule } from "../types.js";
import { offsetToLineCol } from "../source.js";

interface LLMFindingRaw {
  line_start: number;
  line_end: number;
  snippet: string;
  message: string;
}

/**
 * Runs an Isomodel Plan that asks a smart model to scan a single file for
 * small-model-hostile phrasing that the deterministic rules miss.
 */
async function runFilePlan(
  ctx: LintContext,
  model: ModelProvider,
  plan: Plan,
  ruleId: string,
  severity: "error" | "warn" | "info",
): Promise<LintFinding[]> {
  const runtime = new Runtime(model, { logger: createLogger("silent") });
  let result;
  try {
    result = await runtime.run(plan, { file: ctx.file, source: ctx.source });
  } catch {
    return [];
  }
  if (!result.ok) return [];

  const raw = Array.isArray(result.final) ? (result.final as LLMFindingRaw[]) : [];
  const findings: LintFinding[] = [];
  const lines = ctx.source.split("\n");

  for (const f of raw) {
    const lineStart = clamp(f.line_start, 1, lines.length);
    const lineEnd = clamp(f.line_end, lineStart, lines.length);
    const offsetStart = ctx.line_starts[lineStart - 1] ?? 0;
    const offsetEnd =
      (ctx.line_starts[lineEnd] ?? ctx.source.length) - 1;
    const start = offsetToLineCol(ctx, offsetStart);
    const end = offsetToLineCol(ctx, offsetEnd);
    const snippet =
      typeof f.snippet === "string" && f.snippet.trim()
        ? f.snippet.slice(0, 200)
        : lines.slice(lineStart - 1, lineEnd).join("\n").slice(0, 200);

    findings.push({
      rule_id: ruleId,
      severity,
      file: ctx.file,
      range: {
        line: start.line,
        column: start.column,
        end_line: end.line,
        end_column: end.column,
      },
      message: (f.message ?? "small-model-hostile phrasing").slice(0, 240),
      snippet,
      llm_fixable: true,
    });
  }
  return findings;
}

function clamp(n: number, lo: number, hi: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/** ---- llm-atomicity -------------------------------------------------- */

const atomicityPlan: Plan = {
  version: "1",
  name: "llm-atomicity",
  description:
    "Find instructions that bundle multiple atomic actions into one step.",
  input_schema: {
    type: "object",
    required: ["file", "source"],
    properties: {
      file: { type: "string" },
      source: { type: "string", minLength: 1 },
    },
  },
  steps: [
    {
      id: "scan",
      title: "Scan for non-atomic instructions",
      instruction:
        "Read the markdown file. Find every instruction that asks the reader to do more than one atomic action in a single sentence or bullet (e.g., 'extract X, save Y, and update Z'). Return ONLY findings that would confuse a 7B model. Do NOT flag headings, tables, or code blocks. Return an array of findings.",
      inputs: ["$input"],
      constraints: [
        { rule: "Only flag true non-atomic instructions" },
        { rule: "line_start and line_end are 1-based integers within the source" },
        { rule: "snippet is the exact phrase from the source (<=200 chars)" },
      ],
      expected_output: {
        kind: "json",
        json_schema: {
          type: "array",
          items: {
            type: "object",
            required: ["line_start", "line_end", "snippet", "message"],
            additionalProperties: false,
            properties: {
              line_start: { type: "integer", minimum: 1 },
              line_end: { type: "integer", minimum: 1 },
              snippet: { type: "string", minLength: 1, maxLength: 300 },
              message: { type: "string", minLength: 5, maxLength: 240 },
            },
          },
        },
      },
      failure_handling: { max_retries: 1, on_invalid: "repair" },
    },
  ],
  final_output: "$steps.scan",
};

export const llmAtomicity: Rule = {
  id: "llm-atomicity",
  tier: "llm",
  severity: "warn",
  description: "LLM: flag instructions bundling multiple atomic actions.",
  async checkLLM(ctx, model) {
    return runFilePlan(ctx, model, atomicityPlan, "llm-atomicity", "warn");
  },
};

/** ---- llm-implicit-context ------------------------------------------ */

const implicitContextPlan: Plan = {
  version: "1",
  name: "llm-implicit-context",
  description:
    "Find statements that rely on context not present in the current file.",
  input_schema: atomicityPlan.input_schema,
  steps: [
    {
      id: "scan",
      title: "Scan for implicit-context phrases",
      instruction:
        "Read the markdown file. Find phrases that rely on context not present in this file (e.g., 'use the usual format', 'follow the normal convention', 'apply the default rules') without stating the format, convention, or rules. Do NOT flag explicit cross-file references like `_shared.md` or a named table. Return a JSON array.",
      inputs: ["$input"],
      constraints: [
        { rule: "Only flag phrases that would require the model to guess" },
        { rule: "Cross-file refs to a named file or named section are OK" },
      ],
      expected_output: atomicityPlan.steps[0].expected_output,
      failure_handling: { max_retries: 1, on_invalid: "repair" },
    },
  ],
  final_output: "$steps.scan",
};

export const llmImplicitContext: Rule = {
  id: "llm-implicit-context",
  tier: "llm",
  severity: "warn",
  description: "LLM: flag phrases that rely on external unstated context.",
  async checkLLM(ctx, model) {
    return runFilePlan(ctx, model, implicitContextPlan, "llm-implicit-context", "warn");
  },
};

/** ---- llm-unexplained-schema ---------------------------------------- */

const unexplainedSchemaPlan: Plan = {
  version: "1",
  name: "llm-unexplained-schema",
  description:
    "Find output contracts described in prose instead of shown as a concrete example.",
  input_schema: atomicityPlan.input_schema,
  steps: [
    {
      id: "scan",
      title: "Scan for prose-described outputs",
      instruction:
        "Read the markdown file. Find places where a step tells the reader to return JSON / a table / a structured output, but only describes it in prose ('an object with a name and a score') without an inline example or JSON Schema. Do NOT flag steps where a concrete example or schema is shown within 10 lines of the instruction. Return a JSON array.",
      inputs: ["$input"],
      constraints: [
        { rule: "Only flag when no concrete example or schema is nearby" },
      ],
      expected_output: atomicityPlan.steps[0].expected_output,
      failure_handling: { max_retries: 1, on_invalid: "repair" },
    },
  ],
  final_output: "$steps.scan",
};

export const llmUnexplainedSchema: Rule = {
  id: "llm-unexplained-schema",
  tier: "llm",
  severity: "warn",
  description: "LLM: output described in prose with no example / schema nearby.",
  async checkLLM(ctx, model) {
    return runFilePlan(ctx, model, unexplainedSchemaPlan, "llm-unexplained-schema", "warn");
  },
};

export const LLM_RULES: Rule[] = [
  llmAtomicity,
  llmImplicitContext,
  llmUnexplainedSchema,
];
