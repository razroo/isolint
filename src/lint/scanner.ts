import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export interface DiscoveredFile {
  abs_path: string;
  rel_path: string;
  source: string;
}

/**
 * Walk a directory tree and return all matching files.
 * Honors ignore globs (simple glob: *, **, ? and literal segments).
 */
export function discoverFiles(
  root: string,
  opts: { include_ext: string[]; ignore: string[] },
): DiscoveredFile[] {
  const rootAbs = resolve(root);
  const results: DiscoveredFile[] = [];
  const ignoreMatchers = opts.ignore.map(globToRegExp);

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = resolve(dir, name);
      const rel = relative(rootAbs, abs);
      if (ignoreMatchers.some((re) => re.test(rel) || re.test(rel + "/"))) continue;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
      } else if (st.isFile()) {
        const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
        if (opts.include_ext.includes(ext)) {
          let source: string;
          try {
            source = readFileSync(abs, "utf8");
          } catch {
            continue;
          }
          results.push({ abs_path: abs, rel_path: rel, source });
        }
      }
    }
  }

  const stat = statSync(rootAbs);
  if (stat.isFile()) {
    const source = readFileSync(rootAbs, "utf8");
    results.push({ abs_path: rootAbs, rel_path: rootAbs.split("/").pop() ?? "", source });
  } else {
    walk(rootAbs);
  }
  return results;
}

/**
 * Convert a simple glob pattern to a RegExp. Supports:
 *  - `**` matches any number of path segments (including zero)
 *  - `*`  matches any characters except `/`
 *  - `?`  matches a single character except `/`
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("+^$()|{}[]\\.".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}
