import fs from "fs";
import path from "path";
import { GitHubStats, formatNumber } from "./github";

/**
 * SVG layout configuration.
 * Adjust these values to position the stats text over your background images.
 *
 * The SVG canvas is 1536 x 1024 (matching your existing SVG files).
 * x / y are the pixel coordinates for each text element.
 */
interface StatLine {
  label: string;
  valueKey: keyof GitHubStats;
  x: number;
  y: number;
  fontSize: number;
  fontWeight?: "normal" | "bold";
}

const STAT_LINES: StatLine[] = [
  { label: "Repositories",  valueKey: "repos",       x: 200, y: 420, fontSize: 36, fontWeight: "bold" },
  { label: "Commits",       valueKey: "commits",     x: 200, y: 490, fontSize: 36, fontWeight: "bold" },
  { label: "Stars",         valueKey: "stars",       x: 200, y: 560, fontSize: 36, fontWeight: "bold" },
  { label: "Followers",     valueKey: "followers",   x: 200, y: 630, fontSize: 36, fontWeight: "bold" },
  { label: "Lines of Code", valueKey: "linesOfCode", x: 200, y: 700, fontSize: 36, fontWeight: "bold" },
  { label: "GitHub Age",    valueKey: "accountAge",  x: 200, y: 770, fontSize: 28, fontWeight: "normal" },
];

/** Numeric stat keys that should be formatted with commas */
const NUMERIC_KEYS = new Set<keyof GitHubStats>([
  "repos",
  "commits",
  "stars",
  "followers",
  "linesOfCode",
]);

function formatValue(key: keyof GitHubStats, value: GitHubStats[keyof GitHubStats]): string {
  if (NUMERIC_KEYS.has(key) && typeof value === "number") {
    return formatNumber(value);
  }
  return String(value);
}

/**
 * Builds the <text> overlay elements for the stats.
 * Each stat renders as:   Label ............. Value
 */
function buildStatElements(stats: GitHubStats, theme: "dark" | "light"): string {
  const textColor = theme === "dark" ? "#e6edf3" : "#24292f";
  const labelColor = theme === "dark" ? "#8b949e" : "#57606a";
  const valueColor = theme === "dark" ? "#58a6ff" : "#0969da";

  return STAT_LINES.map((line) => {
    const value = formatValue(line.valueKey, stats[line.valueKey]);
    const weight = line.fontWeight ?? "normal";

    return `
  <!-- ${line.label} -->
  <text
    x="${line.x}"
    y="${line.y}"
    font-family="'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
    font-size="${line.fontSize}"
    font-weight="${weight}"
    fill="${labelColor}"
  >${line.label}</text>
  <text
    x="${1536 - line.x}"
    y="${line.y}"
    font-family="'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
    font-size="${line.fontSize}"
    font-weight="${weight}"
    fill="${valueColor}"
    text-anchor="end"
  >${value}</text>`;
  }).join("\n");
}

/**
 * Reads an existing SVG file (which contains a base64 background image),
 * injects a stats overlay, and returns the updated SVG string.
 *
 * The function looks for the closing </svg> tag and inserts the overlay
 * elements just before it, so the stats appear on top of the background.
 */
function injectStatsIntoSvg(
  svgContent: string,
  stats: GitHubStats,
  theme: "dark" | "light"
): string {
  const overlay = buildStatElements(stats, theme);

  // Insert overlay group just before </svg>
  const closingTag = "</svg>";
  const insertionPoint = svgContent.lastIndexOf(closingTag);

  if (insertionPoint === -1) {
    throw new Error("Could not find closing </svg> tag in SVG file");
  }

  return (
    svgContent.slice(0, insertionPoint) +
    `\n  <g id="stats-overlay">\n${overlay}\n  </g>\n` +
    closingTag
  );
}

/**
 * Removes a previously injected stats overlay group so the SVG can be
 * re-injected cleanly on subsequent runs.
 */
function removeExistingOverlay(svgContent: string): string {
  // Remove everything between <g id="stats-overlay"> and </g> (inclusive)
  return svgContent.replace(
    /\n\s*<g id="stats-overlay">[\s\S]*?<\/g>\n/,
    "\n"
  );
}

/** Update both dark_mode.svg and light_mode.svg with fresh stats */
export function updateSvgFiles(
  stats: GitHubStats,
  darkSvgPath: string,
  lightSvgPath: string
): void {
  for (const { filePath, theme } of [
    { filePath: darkSvgPath, theme: "dark" as const },
    { filePath: lightSvgPath, theme: "light" as const },
  ]) {
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      console.warn(`SVG file not found: ${resolvedPath} — skipping`);
      continue;
    }

    let content = fs.readFileSync(resolvedPath, "utf-8");
    content = removeExistingOverlay(content);
    content = injectStatsIntoSvg(content, stats, theme);
    fs.writeFileSync(resolvedPath, content, "utf-8");

    console.log(`  ✓ Updated ${path.basename(filePath)} (${theme} theme)`);
  }
}
