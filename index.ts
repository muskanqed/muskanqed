import "dotenv/config";
import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import fs from "fs";
import path from "path";

// ─── Config ───────────────────────────────────────────────────────────────────

const USERNAME  = process.env.GH_USERNAME ?? (() => { throw new Error("GH_USERNAME not set") })();
const TOKEN     = process.env.GH_TOKEN    ?? (() => { throw new Error("GH_TOKEN not set") })();
const CACHE_DIR = "cache";
const OUT_DIR   = "generated";

const LANG_COLORS: Record<string, string> = {
  TypeScript:  "#3178c6",
  JavaScript:  "#f1e05a",
  Python:      "#3572A5",
  Rust:        "#dea584",
  Go:          "#00ADD8",
  CSS:         "#563d7c",
  HTML:        "#e34c26",
  Java:        "#b07219",
  "C++":       "#f34b7d",
  Shell:       "#89e051",
  Vue:         "#41b883",
  Dart:        "#00B4AB",
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface Repo {
  name:          string;
  owner:         string;
  stars:         number;
  forks:         number;
  language:      string | null;
  isFork:        boolean;
}

interface LocEntry {
  additions: number;
  deletions: number;
}

interface CachedLoc   { [repoFullName: string]: LocEntry }
interface CachedRepos { repos: Repo[]; fetchedAt: string }

interface Stats {
  name:          string;
  login:         string;
  followers:     number;
  totalStars:    number;
  totalForks:    number;
  totalCommits:  number;
  totalPRs:      number;
  totalIssues:   number;
  linesAdded:    number;
  linesDeleted:  number;
  topLangs:      { name: string; size: number; color: string }[];
  updatedAt:     string;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

function readCache<T>(filename: string): T | null {
  const filepath = path.join(CACHE_DIR, filename);
  if (!fs.existsSync(filepath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeCache(filename: string, data: unknown): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CACHE_DIR, filename),
    JSON.stringify(data, null, 2),
    "utf-8"
  );
  console.log(`  💾 cache/${filename} saved`);
}

// ─── GitHub clients ───────────────────────────────────────────────────────────

const gql = graphql.defaults({
  headers: { authorization: `token ${TOKEN}` },
});

const rest = new Octokit({ auth: TOKEN });

// ─── GraphQL: user + contributions ───────────────────────────────────────────

const USER_QUERY = `
  query($login: String!) {
    user(login: $login) {
      name
      login
      followers { totalCount }
      contributionsCollection {
        totalCommitContributions
        totalPullRequestContributions
        totalIssueContributions
      }
    }
  }
`;

// ─── Fetch repos (with cache) ─────────────────────────────────────────────────

async function fetchRepos(): Promise<Repo[]> {
  // Cache expires after 6 hours
  const cached = readCache<CachedRepos>("repos.json");
  if (cached) {
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (age < 6 * 60 * 60 * 1000) {
      console.log("  📦 repos: using cache");
      return cached.repos;
    }
  }

  console.log("  🌐 repos: fetching from API...");
  const { data } = await rest.repos.listForUser({
    username: USERNAME,
    per_page: 100,
    type: "all",
  });

  const repos: Repo[] = data.map((r) => ({
    name:     r.name,
    owner:    r.owner?.login ?? USERNAME,
    stars:    r.stargazers_count ?? 0,
    forks:    r.forks_count ?? 0,
    language: r.language ?? null,
    isFork:   r.fork,
  }));

  writeCache("repos.json", { repos, fetchedAt: new Date().toISOString() });
  return repos;
}

// ─── Fetch lines of code (with cache) ────────────────────────────────────────
// This is the expensive call — GitHub has to compute contributor stats per repo.
// We cache individual repo results so we only fetch new/uncached repos.

async function fetchLoc(repos: Repo[]): Promise<CachedLoc> {
  const cached = readCache<CachedLoc>("loc.json") ?? {};
  const result: CachedLoc = { ...cached };

  for (const repo of repos) {
    const key = `${repo.owner}/${repo.name}`;
    if (result[key]) continue; // already cached

    try {
      console.log(`  📏 LOC: fetching ${key}...`);

      // GitHub returns 202 (computing) on first call — retry once
      let contributors;
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await rest.repos.getContributorsStats({
          owner: repo.owner,
          repo:  repo.name,
        });
        if (res.status === 200) { contributors = res.data; break; }
        await new Promise((r) => setTimeout(r, 3000)); // wait and retry
      }

      if (!contributors) continue;

      const myStats = contributors.find(
        (c) => c.author?.login?.toLowerCase() === USERNAME.toLowerCase()
      );

      if (myStats?.weeks) {
        const additions = myStats.weeks.reduce((acc, w) => acc + (w.a ?? 0), 0);
        const deletions = myStats.weeks.reduce((acc, w) => acc + (w.d ?? 0), 0);
        result[key] = { additions, deletions };
      }
    } catch {
      // Rate limited or private — skip silently
    }
  }

  writeCache("loc.json", result);
  return result;
}

// ─── Aggregate stats ──────────────────────────────────────────────────────────

async function fetchStats(repos: Repo[], loc: CachedLoc): Promise<Stats> {
  const { user } = await gql<any>(USER_QUERY, { login: USERNAME });

  const ownedRepos = repos.filter((r) => !r.isFork && r.owner === USERNAME);

  const totalStars = ownedRepos.reduce((acc, r) => acc + r.stars, 0);
  const totalForks = ownedRepos.reduce((acc, r) => acc + r.forks, 0);

  // Language breakdown from owned repos
  const langMap: Record<string, number> = {};
  for (const repo of ownedRepos) {
    if (repo.language) langMap[repo.language] = (langMap[repo.language] ?? 0) + 1;
  }

  const topLangs = Object.entries(langMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, size]) => ({
      name,
      size,
      color: LANG_COLORS[name] ?? "#8b949e",
    }));

  // Lines of code totals
  const linesAdded   = Object.values(loc).reduce((acc, v) => acc + v.additions, 0);
  const linesDeleted = Object.values(loc).reduce((acc, v) => acc + v.deletions, 0);

  const stats: Stats = {
    name:         user.name ?? user.login,
    login:        user.login,
    followers:    user.followers.totalCount,
    totalStars,
    totalForks,
    totalCommits: user.contributionsCollection.totalCommitContributions,
    totalPRs:     user.contributionsCollection.totalPullRequestContributions,
    totalIssues:  user.contributionsCollection.totalIssueContributions,
    linesAdded,
    linesDeleted,
    topLangs,
    updatedAt:    new Date().toUTCString(),
  };

  writeCache("stats.json", stats);
  return stats;
}

// ─── Themes ───────────────────────────────────────────────────────────────────

type Theme = "light" | "dark";

const THEMES = {
  dark: {
    bg:      "#0d1117",
    border:  "#30363d",
    divider: "#21262d",
    title:   "#e6edf3",
    muted:   "#8b949e",
    text:    "#c9d1d9",
    accent:  "#58a6ff",
    green:   "#3fb950",
  },
  light: {
    bg:      "#ffffff",
    border:  "#d0d7de",
    divider: "#eaeef2",
    title:   "#1f2328",
    muted:   "#656d76",
    text:    "#1f2328",
    accent:  "#0969da",
    green:   "#1a7f37",
  },
} as const;

// ─── SVG shared styles ────────────────────────────────────────────────────────

function styles(theme: Theme): string {
  const t = THEMES[theme];
  return `<style>
    * { font-family: 'Segoe UI', Ubuntu, 'Helvetica Neue', sans-serif; }
    .bg     { fill: ${t.bg}; }
    .border { fill: none; stroke: ${t.border}; stroke-width: 1; }
    .title  { font-size: 20px; font-weight: 700; fill: ${t.title}; }
    .muted  { font-size: 12px; fill: ${t.muted}; }
    .label  { font-size: 13px; fill: ${t.text}; }
    .section{ font-size: 11px; font-weight: 600; letter-spacing: 1.5px; fill: ${t.muted}; }
    .value  { font-size: 13px; font-weight: 700; fill: ${t.accent}; }
    .green  { fill: ${t.green}; }
  </style>`;
}

// ─── SVG: Stats card ──────────────────────────────────────────────────────────

function statsCard(stats: Stats, theme: Theme): string {
  const t = THEMES[theme];

  const rows: [string, string, string | number][] = [
    ["⭐", "Total Stars",        stats.totalStars.toLocaleString()],
    ["🍴", "Total Forks",        stats.totalForks.toLocaleString()],
    ["💻", "Commits (this year)", stats.totalCommits.toLocaleString()],
    ["🔃", "Pull Requests",      stats.totalPRs.toLocaleString()],
    ["🐛", "Issues Opened",      stats.totalIssues.toLocaleString()],
    ["👥", "Followers",          stats.followers.toLocaleString()],
    ["➕", "Lines Added",        `+${stats.linesAdded.toLocaleString()}`],
    ["➖", "Lines Deleted",      `-${stats.linesDeleted.toLocaleString()}`],
  ];

  const rowsSVG = rows
    .map(([icon, label, value], i) => {
      const y = 118 + i * 28;
      return `
  <text x="25"  y="${y}" class="label">${icon}  ${label}</text>
  <text x="470" y="${y}" class="value" text-anchor="end">${value}</text>
  <line x1="25" y1="${y + 7}" x2="470" y2="${y + 7}" stroke="${t.divider}" stroke-width="1"/>`;
    })
    .join("\n");

  const h = 118 + rows.length * 28 + 20;

  return `<svg width="495" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>${styles(theme)}</defs>
  <rect class="bg" width="495" height="${h}" rx="10"/>
  <rect class="border" x="0.5" y="0.5" width="494" height="${h - 1}" rx="10"/>

  <text x="25" y="40" class="title">${stats.name}</text>
  <text x="25" y="58" class="muted">@${stats.login}</text>
  <line x1="25" y1="74" x2="470" y2="74" stroke="${t.border}" stroke-width="1"/>
  <text x="25" y="94" class="section">GITHUB STATS</text>
  ${rowsSVG}
  <text x="470" y="${h - 8}" class="muted" text-anchor="end">Updated ${stats.updatedAt}</text>
</svg>`.trim();
}

// ─── SVG: Language card ───────────────────────────────────────────────────────

function langCard(stats: Stats, theme: Theme): string {
  const t = THEMES[theme];
  const total = stats.topLangs.reduce((acc, l) => acc + l.size, 0);
  const h     = 80 + stats.topLangs.length * 38 + 20;

  // Segmented progress bar
  let barX = 25;
  const barW = 445;
  const segments = stats.topLangs.map((lang) => {
    const w   = (lang.size / total) * barW;
    const seg = `<rect x="${barX.toFixed(1)}" y="52" width="${w.toFixed(1)}" height="10" fill="${lang.color}" rx="2"/>`;
    barX += w;
    return seg;
  });

  const langRows = stats.topLangs.map((lang, i) => {
    const pct = ((lang.size / total) * 100).toFixed(1);
    const y   = 90 + i * 38;
    const barLen = ((lang.size / total) * 380).toFixed(0);
    return `
  <circle cx="25" cy="${y}" r="6" fill="${lang.color}"/>
  <text x="40"  y="${y + 5}" class="label">${lang.name}</text>
  <text x="470" y="${y + 5}" class="value" text-anchor="end">${pct}%</text>
  <rect x="40"  y="${y + 10}" width="${barLen}" height="4" rx="2" fill="${lang.color}" opacity="0.35"/>`;
  });

  return `<svg width="495" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>${styles(theme)}</defs>
  <rect class="bg" width="495" height="${h}" rx="10"/>
  <rect class="border" x="0.5" y="0.5" width="494" height="${h - 1}" rx="10"/>

  <text x="25"  y="30" class="section">TOP LANGUAGES</text>
  <text x="470" y="30" class="muted" text-anchor="end">by repo count</text>
  ${segments.join("\n")}
  ${langRows.join("\n")}
  <text x="470" y="${h - 8}" class="muted" text-anchor="end">Updated ${stats.updatedAt}</text>
</svg>`.trim();
}

// ─── Write output ──────────────────────────────────────────────────────────────

function write(filename: string, content: string): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(`${OUT_DIR}/${filename}`, content, "utf-8");
  console.log(`  ✔ generated/${filename}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🚀 Generating profile for @${USERNAME}\n`);

  console.log("📡 Fetching data:");
  const repos = await fetchRepos();
  const loc   = await fetchLoc(repos);
  const stats = await fetchStats(repos, loc);

  console.log("\n🎨 Generating SVGs:");
  write("stats-dark.svg",  statsCard(stats, "dark"));
  write("stats-light.svg", statsCard(stats, "light"));
  write("langs-dark.svg",  langCard(stats, "dark"));
  write("langs-light.svg", langCard(stats, "light"));

  console.log("\n✅ Done!\n");
}

main().catch((err: Error) => {
  console.error("❌", err.message);
  process.exit(1);
});