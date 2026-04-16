/**
 * Markdown AST infrastructure
 * ---------------------------
 * Lazy, memoized `parseMarkdown(source)` that returns an mdast Root.
 *
 * Rules that need structural queries (is this a heading / list item / table
 * cell / blockquote?) call `getAst(ctx)` instead of writing fresh regex.
 * The current regex rules keep working — AST is additive.
 *
 * Each call caches the parse result on `ctx` via a WeakMap so multiple rules
 * on the same file re-use one parse.
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root, Heading, Paragraph } from "mdast";
import { visit } from "unist-util-visit";
import type { LintContext } from "./types.js";

const astCache = new WeakMap<LintContext, Root>();

const parser = unified().use(remarkParse);

export function getAst(ctx: LintContext): Root {
  const cached = astCache.get(ctx);
  if (cached) return cached;
  const root = parser.parse(ctx.source) as Root;
  astCache.set(ctx, root);
  return root;
}

/** Concatenate all text children of a node. Cheap, no escaping. */
export function nodeText(node: { type: string; children?: unknown[]; value?: string }): string {
  if (node.type === "text" || node.type === "inlineCode") {
    return (node as { value: string }).value ?? "";
  }
  if (!node.children) return "";
  const parts: string[] = [];
  for (const child of node.children as Array<{ type: string; children?: unknown[]; value?: string }>) {
    parts.push(nodeText(child));
  }
  return parts.join("");
}

/** Walk every heading in the AST, yielding `{ depth, text, start, end }`. */
export function* headings(root: Root): Generator<{ depth: number; text: string; start: number; end: number }> {
  for (const node of root.children) {
    if (node.type === "heading") {
      const h = node as Heading;
      yield {
        depth: h.depth,
        text: nodeText(h).trim(),
        start: h.position?.start.offset ?? 0,
        end: h.position?.end.offset ?? 0,
      };
    }
  }
}

/** Walk every paragraph, yielding its offsets + flattened text. */
export function* paragraphs(root: Root): Generator<{ text: string; start: number; end: number }> {
  const seen: Array<{ text: string; start: number; end: number }> = [];
  visit(root, "paragraph", (node: Paragraph) => {
    seen.push({
      text: nodeText(node),
      start: node.position?.start.offset ?? 0,
      end: node.position?.end.offset ?? 0,
    });
  });
  for (const p of seen) yield p;
}

/** True when `offset` falls inside a table cell. Used for context-aware rules. */
export function isInsideTable(root: Root, offset: number): boolean {
  let hit = false;
  visit(root, (node) => {
    if (hit) return false;
    if (node.type !== "table") return undefined;
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? 0;
    if (offset >= start && offset < end) hit = true;
    return undefined;
  });
  return hit;
}

/**
 * Validate that fenced code blocks tagged with a specific language actually
 * parse as that language. Currently only JSON — more can follow (YAML, etc).
 *
 * Returns `{ line, column, message }` for each invalid block. Called by the
 * new `invalid-code-fence` rule.
 */
export interface CodeFenceProblem {
  start_offset: number;
  end_offset: number;
  language: string;
  error: string;
}

export function findInvalidJsonFences(root: Root): CodeFenceProblem[] {
  const problems: CodeFenceProblem[] = [];
  visit(root, "code", (node) => {
    const lang = (node.lang ?? "").toLowerCase();
    if (lang !== "json") return;
    const value = node.value ?? "";
    if (!value.trim()) return;
    try {
      JSON.parse(value);
    } catch (err) {
      problems.push({
        start_offset: node.position?.start.offset ?? 0,
        end_offset: node.position?.end.offset ?? 0,
        language: lang,
        error: (err as Error).message.split("\n")[0],
      });
    }
  });
  return problems;
}

export type { Root };
