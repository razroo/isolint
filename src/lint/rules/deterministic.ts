/**
 * Tier 1 rules: deterministic, zero-cost, regex-based.
 *
 * Each rule flags a pattern that weak models (Minimax 2.5, Nemotron 3,
 * Mistral 7B, local models) reliably fail on. Rules intentionally err
 * on the side of false positives that are easy to dismiss — missing a
 * failure mode is far more expensive than an extra warning.
 *
 * Every rule skips fenced code blocks, inline code, and HTML comments
 * via the skip intervals built by computeSkipIntervals.
 */

import { computeSkipIntervals, rangeFromOffsets, scanMatches } from "../source.js";
import type { Fix, LintContext, LintFinding, Rule } from "../types.js";

function findingsFrom(
  ctx: LintContext,
  rule: { id: string; severity: "error" | "warn" | "info" },
  matches: Array<{ start: number; end: number; message: string; fix?: Fix; llm_fixable?: boolean }>,
): LintFinding[] {
  return matches.map(({ start, end, message, fix, llm_fixable }) => ({
    rule_id: rule.id,
    severity: rule.severity,
    file: ctx.file,
    range: rangeFromOffsets(ctx, start, end),
    message,
    snippet: ctx.source.slice(start, end),
    ...(fix ? { fix } : {}),
    ...(llm_fixable ? { llm_fixable: true } : {}),
  }));
}

function skip(ctx: LintContext) {
  return computeSkipIntervals(ctx.source, ctx.config.skip_spans);
}

/** ---- Rule: soft-imperative ------------------------------------------ */

export const softImperative: Rule = {
  id: "soft-imperative",
  tier: "deterministic",
  severity: "warn",
  description: "Use MUST / ALWAYS / NEVER instead of should / might / could / consider.",
  check(ctx) {
    const words = ["should", "could", "might", "may want to", "consider", "perhaps", "probably", "ideally", "preferably"];
    const re = new RegExp(`\\b(${words.join("|")})\\b`, "gi");
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" is a soft imperative; weak models treat it as optional. Use MUST / ALWAYS / NEVER or drop it.`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, softImperative, matches);
  },
};

/** ---- Rule: vague-quantifier ----------------------------------------- */

export const vagueQuantifier: Rule = {
  id: "vague-quantifier",
  tier: "deterministic",
  severity: "warn",
  description: "Use an exact number instead of some / several / a few / many / most.",
  check(ctx) {
    const re = /\b(some|several|a few|many|most of|a number of|numerous|various)\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" has no operational meaning. Give a number, a range, or an upper bound.`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, vagueQuantifier, matches);
  },
};

/** ---- Rule: taste-word ------------------------------------------------ */

export const tasteWord: Rule = {
  id: "taste-word",
  tier: "deterministic",
  severity: "warn",
  description: "Remove taste-based words; weak models can't evaluate them.",
  check(ctx) {
    const builtin = [
      "creative",
      "engaging",
      "appropriate",
      "polished",
      "natural",
      "nice",
      "good",
      "great",
      "feel free",
      "as needed",
      "when relevant",
      "if appropriate",
      "as appropriate",
      "passionate",
      "leveraged",
      "utilized",
      "spearheaded",
      "cutting-edge",
      "world-class",
      "best-in-class",
      "robust",
      "seamless",
      "synergy",
      "holistic",
    ];
    const extra = (ctx.config.options["taste-word.extra"] as string[] | undefined) ?? [];
    const words = [...builtin, ...extra];
    const re = new RegExp(`\\b(${words.map(escapeRe).join("|")})\\b`, "gi");
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" is taste-based; weak models can't evaluate it. Replace with a measurable rule.`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, tasteWord, matches);
  },
};

/** ---- Rule: ambiguous-deictic ---------------------------------------- */

export const ambiguousDeictic: Rule = {
  id: "ambiguous-deictic",
  tier: "deterministic",
  severity: "info",
  description: "Prefer explicit refs over 'above' / 'below' / 'the following' — weak models lose position.",
  check(ctx) {
    const re = /\b(the section above|section below|above section|below section|as mentioned above|as noted above|as described below|the table above|the table below)\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" relies on position. Name the section explicitly (e.g., "Block A — Role Summary").`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, ambiguousDeictic, matches);
  },
};

/** ---- Rule: double-negation ------------------------------------------ */

export const doubleNegation: Rule = {
  id: "double-negation",
  tier: "deterministic",
  severity: "warn",
  description: "Avoid double negatives — weak models flip the sign.",
  check(ctx) {
    const re = /\b(don'?t\s+(?:forget\s+to\s+)?(?:not|never)|never\s+(?:not|fail to)|not\s+un\w+|cannot\s+not)\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `Double negative: "${m[0]}". Rewrite as a positive imperative.`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, doubleNegation, matches);
  },
};

/** ---- Rule: long-sentence -------------------------------------------- */

export const longSentence: Rule = {
  id: "long-sentence",
  tier: "deterministic",
  severity: "info",
  description: "Split sentences longer than N words — weak models drop clauses.",
  check(ctx) {
    const max = (ctx.config.options["long-sentence.max_words"] as number | undefined) ?? 35;
    const skips = skip(ctx);
    const source = ctx.source;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];

    const sentRe = /[^.!?\n]+[.!?](?=\s|$)/g;
    for (const m of scanMatches(source, sentRe, skips)) {
      const text = m[0].trim();
      if (text.startsWith("#") || text.startsWith(">")) continue;
      if (text.startsWith("|") || text.startsWith("- ") || text.startsWith("* ")) continue;
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length > max) {
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          message: `Sentence is ${words.length} words (max ${max}). Split into shorter statements.`,
          llm_fixable: true,
        });
      }
    }
    return findingsFrom(ctx, longSentence, matches);
  },
};

/** ---- Rule: pronoun-no-antecedent ------------------------------------ */

export const pronounNoAntecedent: Rule = {
  id: "pronoun-no-antecedent",
  tier: "deterministic",
  severity: "info",
  description: "Pronoun at the start of a sentence after a list/heading — weak models lose the antecedent.",
  check(ctx) {
    const lines = ctx.source.split("\n");
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prev = lines[i - 1] ?? "";
      const trimmed = line.trimStart();
      const leading = line.length - trimmed.length;
      const start = offset + leading;

      const prevIsStructural =
        prev.trim() === "" ||
        prev.trim().startsWith("#") ||
        prev.trim().startsWith("|") ||
        prev.trim().startsWith("-") ||
        prev.trim().startsWith("*") ||
        prev.trim().startsWith("```");

      if (prevIsStructural) {
        const m = /^(It|This|That|They|These|Those)\b/.exec(trimmed);
        if (m) {
          matches.push({
            start,
            end: start + m[0].length,
            message: `"${m[0]}" at start of block has no clear antecedent. Name the noun explicitly.`,
            llm_fixable: true,
          });
        }
      }
      offset += line.length + 1;
    }
    const skips = skip(ctx);
    const filtered = matches.filter((m) => !skips.some(([s, e]) => m.start >= s && m.start < e));
    return findingsFrom(ctx, pronounNoAntecedent, filtered);
  },
};

/** ---- Rule: enum-without-list ---------------------------------------- */

export const enumWithoutList: Rule = {
  id: "enum-without-list",
  tier: "deterministic",
  severity: "warn",
  description: "Phrases like 'one of the usual/standard' must list the allowed values inline.",
  check(ctx) {
    const re = /\bone of (?:the )?(?:usual|standard|typical|common|known) (?:categories|values|options|types)\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `Enum referenced without values. List the allowed values inline: "one of [a, b, c]".`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, enumWithoutList, matches);
  },
};

/** ---- Rule: word-count-target ---------------------------------------- */

export const wordCountTarget: Rule = {
  id: "word-count-target",
  tier: "deterministic",
  severity: "info",
  description: "Prefer character / sentence counts over word counts — weak models count tokens poorly.",
  check(ctx) {
    const re = /\b(\d+)[-–—]?(?:\s*(?:to|-)\s*\d+)?\s*words?\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" — weak models count words unreliably. Prefer characters ("max 240 chars") or sentences ("2-3 sentences").`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, wordCountTarget, matches);
  },
};

/** ---- Rule: implicit-conditional ------------------------------------- */

export const implicitConditional: Rule = {
  id: "implicit-conditional",
  tier: "deterministic",
  severity: "warn",
  description: "Conditional with no operational trigger (when/if relevant, as needed, if appropriate).",
  check(ctx) {
    const re = /\b(when (?:relevant|appropriate|needed|necessary)|as (?:needed|appropriate)|if (?:relevant|appropriate|needed|necessary)|where (?:relevant|appropriate|needed))\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" has no operational trigger. State the exact condition ("if score >= 3.5", "if the field is missing").`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, implicitConditional, matches);
  },
};

/** ---- Rule: trailing-etc --------------------------------------------- */

export const trailingEtc: Rule = {
  id: "trailing-etc",
  tier: "deterministic",
  severity: "warn",
  description: "'etc.' in an instruction is an unclosed set — list the allowed values explicitly.",
  check(ctx) {
    const re = /\b(etc\.?|and so on|and such)\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" leaves the set open. Weak models invent items. List every allowed value explicitly.`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, trailingEtc, matches);
  },
};

/** ---- Rule: heading-without-imperative ------------------------------- */

export const headingWithoutImperative: Rule = {
  id: "heading-without-imperative",
  tier: "deterministic",
  severity: "info",
  description: "Mode/step headings should begin with an imperative verb.",
  check(ctx) {
    if (!ctx.file.match(/modes\/|prompts\/|skills\/|agents\//i)) return [];
    const lines = ctx.source.split("\n");
    const skips = skip(ctx);
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    let offset = 0;
    const verbPattern = /^(Read|Write|Emit|Return|Extract|Classify|Generate|Validate|Compute|Save|Load|Scan|Detect|Build|Call|Fetch|Check|Verify|Update|Append|Skip|Fail|Use|Do|List|Count|Sum|Run|Execute|Apply|Parse|Render|Match|Map|Filter|Sort|Select|Pick|Output|Print|Dispatch|Route|Copy|Resolve|Compare|Score|Ignore|Ask|Reply|Include|Exclude)\b/;
    for (const line of lines) {
      const m = /^\s*(##+)\s+(Step\s+\d+\s*[—-]\s*|Block\s+[A-Z]\s*[—-]\s*)?(.+?)\s*$/.exec(line);
      if (m) {
        const headingText = m[3].trim();
        const headStart = offset + (m.index ?? 0) + line.indexOf(headingText);
        if (
          !verbPattern.test(headingText) &&
          !headingText.match(/^[A-Z][a-z]+(\s+[A-Z][a-z]+)+$/) &&
          !skips.some(([s, e]) => headStart >= s && headStart < e)
        ) {
          matches.push({
            start: headStart,
            end: headStart + headingText.length,
            message: `Heading "${headingText}" does not start with an imperative verb. Weak models skip non-actionable headings.`,
            llm_fixable: true,
          });
        }
      }
      offset += line.length + 1;
    }
    return findingsFrom(ctx, headingWithoutImperative, matches);
  },
};

/** ---- Rule: nested-conditional --------------------------------------- */

export const nestedConditional: Rule = {
  id: "nested-conditional",
  tier: "deterministic",
  severity: "warn",
  description: "Multiple if/unless/except in one sentence — split into a decision table or ordered list.",
  check(ctx) {
    const sentRe = /[^.!?\n]+[.!?](?=\s|$)/g;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, sentRe, skip(ctx))) {
      const text = m[0];
      const count =
        (text.match(/\bif\b/gi)?.length ?? 0) +
        (text.match(/\bunless\b/gi)?.length ?? 0) +
        (text.match(/\bexcept\b/gi)?.length ?? 0) +
        (text.match(/\bwhen\b/gi)?.length ?? 0);
      if (count >= 3) {
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          message: `Sentence has ${count} conditional clauses. Rewrite as a decision table or ordered if/else-if list.`,
          llm_fixable: true,
        });
      }
    }
    return findingsFrom(ctx, nestedConditional, matches);
  },
};

/** ---- Rule: multiple-output-formats ---------------------------------- */

export const multipleOutputFormats: Rule = {
  id: "multiple-output-formats",
  tier: "deterministic",
  severity: "warn",
  description: "One step must return one format — don't ask for JSON and also a summary.",
  check(ctx) {
    const re = /\b(return|output|emit|produce)\b[^.!?\n]{0,120}\b(and\s+(?:also|then))\b[^.!?\n]{0,120}\b(summary|explanation|commentary|markdown|prose|json|list|yaml)\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `Step asks for two output formats. Weak models drop one. Split into two steps.`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, multipleOutputFormats, matches);
  },
};

/** ---- helpers -------------------------------------------------------- */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Full deterministic ruleset, in priority order. */
export const DETERMINISTIC_RULES: Rule[] = [
  softImperative,
  vagueQuantifier,
  tasteWord,
  ambiguousDeictic,
  doubleNegation,
  longSentence,
  pronounNoAntecedent,
  enumWithoutList,
  wordCountTarget,
  implicitConditional,
  trailingEtc,
  headingWithoutImperative,
  nestedConditional,
  multipleOutputFormats,
];
