import type { SmartPlan, SmartPlanLane, SmartPlanOptions } from "./types.js";

const MARKDOWN_TYPE = "xraymarkdown";
const CODE_TYPE = "xraycode";
const MARKDOWN_TYPE_ARGS = [
  "--type-add", `${MARKDOWN_TYPE}:*.md`,
  "--type-add", `${MARKDOWN_TYPE}:*.mdx`,
  "--type-add", `${MARKDOWN_TYPE}:*.rst`,
  "--type-add", `${MARKDOWN_TYPE}:*.adoc`,
  "--type-add", `${MARKDOWN_TYPE}:*.txt`,
];
const CODE_TYPE_ARGS = [
  "--type-add", `${CODE_TYPE}:*.ts`,
  "--type-add", `${CODE_TYPE}:*.tsx`,
  "--type-add", `${CODE_TYPE}:*.js`,
  "--type-add", `${CODE_TYPE}:*.jsx`,
  "--type-add", `${CODE_TYPE}:*.mjs`,
  "--type-add", `${CODE_TYPE}:*.cjs`,
  "--type-add", `${CODE_TYPE}:*.mts`,
  "--type-add", `${CODE_TYPE}:*.cts`,
  "--type-add", `${CODE_TYPE}:*.py`,
  "--type-add", `${CODE_TYPE}:*.go`,
  "--type-add", `${CODE_TYPE}:*.rs`,
  "--type-add", `${CODE_TYPE}:*.java`,
  "--type-add", `${CODE_TYPE}:*.cs`,
  "--type-add", `${CODE_TYPE}:*.c`,
  "--type-add", `${CODE_TYPE}:*.cc`,
  "--type-add", `${CODE_TYPE}:*.cpp`,
  "--type-add", `${CODE_TYPE}:*.h`,
  "--type-add", `${CODE_TYPE}:*.hpp`,
  "--type-add", `${CODE_TYPE}:*.rb`,
  "--type-add", `${CODE_TYPE}:*.php`,
  "--type-add", `${CODE_TYPE}:*.swift`,
  "--type-add", `${CODE_TYPE}:*.kt`,
  "--type-add", `${CODE_TYPE}:*.kts`,
  "--type-add", `${CODE_TYPE}:*.scala`,
  "--type-add", `${CODE_TYPE}:*.sh`,
  "--type-add", `${CODE_TYPE}:*.ps1`,
  "--type-add", `${CODE_TYPE}:*.sql`,
];

const LANES = {
  markdown: {
    name: "markdown" as const,
    args: [...MARKDOWN_TYPE_ARGS, "--type", MARKDOWN_TYPE],
  },
  code: {
    name: "code" as const,
    args: [...CODE_TYPE_ARGS, "--type", CODE_TYPE],
  },
  everything: {
    name: "everything" as const,
    args: [...MARKDOWN_TYPE_ARGS, ...CODE_TYPE_ARGS, "--type-not", MARKDOWN_TYPE, "--type-not", CODE_TYPE],
  },
};

export function planSmartSearch(options: SmartPlanOptions): SmartPlan {
  const regex = options.regex ?? false;
  if (regex) {
    return buildPlan("sequential", "regex search uses one ripgrep walk", [], false, false);
  }

  const lane = laneForExtensionLikeQuery(options.query);
  if (lane !== null) {
    return buildPlan("narrowed", `extension-like query uses ${lane} lane`, [LANES[lane]], true, true);
  }

  if (/\.[a-z0-9]+$/iu.test(options.query)) {
    return buildPlan("fanout", "extension-like query without a known lane uses a fanout", [LANES.markdown, LANES.code, LANES.everything], false, true);
  }

  return buildPlan("fanout", "literal search fans out across all lanes", [LANES.markdown, LANES.code, LANES.everything], false, true);
}

function laneForExtensionLikeQuery(query: string): "markdown" | "code" | null {
  const match = query.match(/\.([a-z0-9]+)\b/u);
  const extension = match?.[1];
  if (!extension) {
    return null;
  }
  if (["md", "mdx", "rst", "adoc", "txt"].includes(extension)) {
    return "markdown";
  }
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "go", "rs", "java", "cs", "c", "cc", "cpp", "h", "hpp", "rb", "php", "swift", "kt", "kts", "scala", "sh", "ps1", "sql"].includes(extension)) {
    return "code";
  }
  return null;
}

function buildPlan(strategy: SmartPlan["strategy"], reason: string, lanes: SmartPlanLane[], fallbackOnZero: boolean, fixedString: boolean): SmartPlan {
  return { strategy, reason, lanes, fallbackOnZero, fixedString };
}
