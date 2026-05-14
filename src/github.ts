import axios from "axios";

const GITHUB_GRAPHQL = "https://api.github.com/graphql";

export interface GitHubStats {
  username: string;
  name: string;
  followers: number;
  repos: number;
  stars: number;
  commits: number;
  linesOfCode: number;
  accountAge: string;
}

interface GraphQLResponse<T> {
  data: T;
  errors?: { message: string }[];
}

function headers(token: string) {
  return { Authorization: `token ${token}` };
}

async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const response = await axios.post<GraphQLResponse<T>>(
    GITHUB_GRAPHQL,
    { query, variables },
    { headers: headers(token) }
  );
  if (response.data.errors?.length) {
    throw new Error(
      `GraphQL error: ${response.data.errors.map((e) => e.message).join(", ")}`
    );
  }
  return response.data.data;
}

/** Fetch basic user info: name, followers, account creation date */
async function getUserInfo(
  token: string,
  login: string
): Promise<{ name: string; followers: number; createdAt: string }> {
  const query = `
    query($login: String!) {
      user(login: $login) {
        name
        followers { totalCount }
        createdAt
      }
    }
  `;
  const data = await graphql<{
    user: { name: string; followers: { totalCount: number }; createdAt: string };
  }>(token, query, { login });
  return {
    name: data.user.name ?? login,
    followers: data.user.followers.totalCount,
    createdAt: data.user.createdAt,
  };
}

/** Fetch total repo count and total stars across all owned repos */
async function getReposAndStars(
  token: string,
  login: string
): Promise<{ repos: number; stars: number }> {
  const query = `
    query($login: String!, $cursor: String) {
      user(login: $login) {
        repositories(
          first: 100
          after: $cursor
          ownerAffiliations: [OWNER]
          isFork: false
        ) {
          totalCount
          pageInfo { endCursor hasNextPage }
          nodes {
            stargazerCount
          }
        }
      }
    }
  `;

  let stars = 0;
  let repos = 0;
  let cursor: string | null = null;
  let hasNextPage = true;

  type ReposStarsResponse = {
    user: {
      repositories: {
        totalCount: number;
        pageInfo: { endCursor: string; hasNextPage: boolean };
        nodes: { stargazerCount: number }[];
      };
    };
  };

  while (hasNextPage) {
    const data: ReposStarsResponse = await graphql<ReposStarsResponse>(
      token,
      query,
      { login, cursor }
    );

    const repoData = data.user.repositories;
    repos = repoData.totalCount;
    stars += repoData.nodes.reduce(
      (sum: number, r: { stargazerCount: number }) => sum + r.stargazerCount,
      0
    );
    hasNextPage = repoData.pageInfo.hasNextPage;
    cursor = repoData.pageInfo.endCursor;
  }

  return { repos, stars };
}

/** Fetch total commit count across all years since account creation */
async function getTotalCommits(
  token: string,
  login: string,
  createdAt: string
): Promise<number> {
  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            totalContributions
          }
        }
      }
    }
  `;

  const startYear = new Date(createdAt).getFullYear();
  const currentYear = new Date().getFullYear();
  let totalCommits = 0;

  for (let year = startYear; year <= currentYear; year++) {
    const from = `${year}-01-01T00:00:00Z`;
    const to =
      year === currentYear
        ? new Date().toISOString()
        : `${year}-12-31T23:59:59Z`;

    const data = await graphql<{
      user: {
        contributionsCollection: {
          contributionCalendar: { totalContributions: number };
        };
      };
    }>(token, query, { login, from, to });

    totalCommits +=
      data.user.contributionsCollection.contributionCalendar.totalContributions;
  }

  return totalCommits;
}

/** Fetch total lines of code (additions - deletions) across all owned repos */
async function getLinesOfCode(
  token: string,
  login: string
): Promise<number> {
  // Get list of owned repos first
  const repoQuery = `
    query($login: String!, $cursor: String) {
      user(login: $login) {
        repositories(
          first: 100
          after: $cursor
          ownerAffiliations: [OWNER]
          isFork: false
        ) {
          pageInfo { endCursor hasNextPage }
          nodes { nameWithOwner }
        }
      }
    }
  `;

  const repoNames: string[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  type RepoListResponse = {
    user: {
      repositories: {
        pageInfo: { endCursor: string; hasNextPage: boolean };
        nodes: { nameWithOwner: string }[];
      };
    };
  };

  while (hasNextPage) {
    const data: RepoListResponse = await graphql<RepoListResponse>(
      token,
      repoQuery,
      { login, cursor }
    );

    const repos = data.user.repositories;
    repoNames.push(...repos.nodes.map((r: { nameWithOwner: string }) => r.nameWithOwner));
    hasNextPage = repos.pageInfo.hasNextPage;
    cursor = repos.pageInfo.endCursor;
  }

  // Fetch contributor stats for each repo via REST API
  let totalLoc = 0;
  const restHeaders = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };

  for (const nameWithOwner of repoNames) {
    const [owner, repo] = nameWithOwner.split("/");
    try {
      // GitHub may return 202 while computing stats — retry once
      let response = await axios.get<
        { author: { login: string } | null; weeks: { a: number; d: number }[] }[]
      >(`https://api.github.com/repos/${owner}/${repo}/stats/contributors`, {
        headers: restHeaders,
      });

      if (response.status === 202) {
        await new Promise((r) => setTimeout(r, 3000));
        response = await axios.get(
          `https://api.github.com/repos/${owner}/${repo}/stats/contributors`,
          { headers: restHeaders }
        );
      }

      if (Array.isArray(response.data)) {
        for (const contributor of response.data) {
          if (contributor.author?.login?.toLowerCase() === login.toLowerCase()) {
            for (const week of contributor.weeks) {
              totalLoc += week.a - week.d;
            }
          }
        }
      }
    } catch {
      // Skip repos that fail (e.g. empty repos)
    }
  }

  return totalLoc;
}

/** Format account age as "X years, Y months, Z days" */
function formatAccountAge(createdAt: string): string {
  const created = new Date(createdAt);
  const now = new Date();

  let years = now.getFullYear() - created.getFullYear();
  let months = now.getMonth() - created.getMonth();
  let days = now.getDate() - created.getDate();

  if (days < 0) {
    months -= 1;
    const prevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    days += prevMonth.getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  const plural = (n: number, word: string) =>
    `${n} ${word}${n !== 1 ? "s" : ""}`;

  const isBirthday = months === 0 && days === 0 ? " 🎂" : "";
  return `${plural(years, "year")}, ${plural(months, "month")}, ${plural(days, "day")}${isBirthday}`;
}

/** Format large numbers with commas */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Main entry point — fetches all stats */
export async function fetchGitHubStats(
  token: string,
  login: string
): Promise<GitHubStats> {
  console.log(`Fetching stats for ${login}...`);

  const userInfo = await getUserInfo(token, login);
  console.log(`  ✓ User info: ${userInfo.name}, ${userInfo.followers} followers`);

  const { repos, stars } = await getReposAndStars(token, login);
  console.log(`  ✓ Repos: ${repos}, Stars: ${stars}`);

  const commits = await getTotalCommits(token, login, userInfo.createdAt);
  console.log(`  ✓ Commits: ${commits}`);

  const linesOfCode = await getLinesOfCode(token, login);
  console.log(`  ✓ Lines of code: ${linesOfCode}`);

  const accountAge = formatAccountAge(userInfo.createdAt);
  console.log(`  ✓ Account age: ${accountAge}`);

  return {
    username: login,
    name: userInfo.name,
    followers: userInfo.followers,
    repos,
    stars,
    commits,
    linesOfCode,
    accountAge,
  };
}
