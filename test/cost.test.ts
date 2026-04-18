import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeCost, formatCost } from "../src/cli/cost.js";
import type { DiscoveredFile } from "../src/lint/scanner.js";

function file(rel_path: string, source: string): DiscoveredFile {
  return { abs_path: "/" + rel_path, rel_path, source };
}

describe("cost report", () => {
  it("buckets files into shared-prefix, modes, and agents", () => {
    const report = computeCost([
      file("AGENTS.md", "# Shared\n\n" + "word ".repeat(200)),
      file("CLAUDE.md", "# Shared\n\n" + "word ".repeat(200)),
      file("modes/apply.md", "# Apply\n\n" + "word ".repeat(100)),
      file("modes/scan.md", "# Scan\n\n" + "word ".repeat(80)),
      file("iso/agents/general-free.md", "# Agent\n\n" + "word ".repeat(50)),
      file("README.md", "# Unrelated\n\n" + "word ".repeat(500)),
    ]);

    assert.equal(report.shared_prefix.length, 2);
    assert.ok(report.shared_prefix.some((f) => f.path === "AGENTS.md"));
    assert.ok(report.shared_prefix.some((f) => f.path === "CLAUDE.md"));

    assert.equal(report.modes.length, 2);
    assert.equal(report.agents.length, 1);

    // README.md is not bucketed because it's not a harness path.
    const allPaths = [
      ...report.shared_prefix.map((f) => f.path),
      ...report.modes.map((f) => f.path),
      ...report.agents.map((f) => f.path),
    ];
    assert.ok(!allPaths.includes("README.md"));
  });

  it("sorts each bucket by approx_tokens descending", () => {
    const report = computeCost([
      file("modes/small.md", "# S\n\n" + "word ".repeat(20)),
      file("modes/large.md", "# L\n\n" + "word ".repeat(500)),
      file("modes/medium.md", "# M\n\n" + "word ".repeat(100)),
    ]);
    const paths = report.modes.map((f) => f.path);
    assert.deepEqual(paths, ["modes/large.md", "modes/medium.md", "modes/small.md"]);
    assert.equal(report.heaviest_mode?.path, "modes/large.md");
  });

  it("sums shared-prefix totals across files", () => {
    const report = computeCost([
      file("AGENTS.md", "x".repeat(4000)),
      file("CLAUDE.md", "x".repeat(8000)),
    ]);
    // chars/4 = 1000 + 2000 = 3000 tokens
    assert.equal(report.shared_prefix_total_tokens, 3000);
  });

  it("computes per-section breakdown for shared-prefix files", () => {
    const source = [
      "## Alpha",
      "",
      "word ".repeat(500),
      "",
      "## Beta",
      "",
      "word ".repeat(100),
    ].join("\n");
    const report = computeCost([file("AGENTS.md", source)]);
    const sections = report.shared_prefix[0].sections;
    assert.ok(sections && sections.length === 2);
    // Sorted by tokens descending.
    assert.equal(sections[0].title, "Alpha");
    assert.ok(sections[0].approx_tokens > sections[1].approx_tokens);
  });

  it("strips frontmatter before counting words", () => {
    const withFrontmatter = [
      "---",
      "description: test",
      "tags: [a, b, c]",
      "---",
      "",
      "body word word word",
    ].join("\n");
    const without = "body word word word";
    const a = computeCost([file("AGENTS.md", withFrontmatter)]);
    const b = computeCost([file("AGENTS.md", without)]);
    assert.equal(a.shared_prefix[0].words, b.shared_prefix[0].words);
  });

  it("formats a readable text report", () => {
    const report = computeCost([
      file("AGENTS.md", "# S\n\n" + "word ".repeat(500)),
      file("modes/apply.md", "# A\n\n" + "word ".repeat(200)),
    ]);
    const out = formatCost(report);
    assert.ok(out.includes("Always-loaded harness overhead"));
    assert.ok(out.includes("AGENTS.md"));
    assert.ok(out.includes("Per-mode context"));
    assert.ok(out.includes("modes/apply.md"));
    assert.ok(out.includes("Worst case"));
  });

  it("does not crash on empty input", () => {
    const report = computeCost([]);
    assert.equal(report.shared_prefix.length, 0);
    assert.equal(report.shared_prefix_total_tokens, 0);
    const out = formatCost(report);
    assert.ok(out.includes("no shared-prefix files"));
  });
});
