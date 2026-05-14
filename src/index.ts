import dotenv from "dotenv";
import path from "path";
import { fetchGitHubStats } from "./github";
import { updateSvgFiles } from "./svg";

dotenv.config();

async function main(): Promise<void> {
  const token = process.env.ACCESS_TOKEN;
  const username = process.env.USER_NAME;

  if (!token) {
    throw new Error(
      "ACCESS_TOKEN environment variable is required.\n" +
        "Create a GitHub Personal Access Token with read:user and repo scopes."
    );
  }
  if (!username) {
    throw new Error("USER_NAME environment variable is required.");
  }

  // Paths to the SVG files (relative to project root)
  const darkSvgPath = path.join(__dirname, "..", "dark_mode.svg");
  const lightSvgPath = path.join(__dirname, "..", "light_mode.svg");

  console.log("=== GitHub Profile README Updater ===\n");

  const stats = await fetchGitHubStats(token, username);

  console.log("\nUpdating SVG files...");
  updateSvgFiles(stats, darkSvgPath, lightSvgPath);

  console.log("\n✅ Done! SVG files updated with latest stats.");
  console.log("\nStats summary:");
  console.log(`  Name:          ${stats.name}`);
  console.log(`  Repositories:  ${stats.repos}`);
  console.log(`  Commits:       ${stats.commits}`);
  console.log(`  Stars:         ${stats.stars}`);
  console.log(`  Followers:     ${stats.followers}`);
  console.log(`  Lines of Code: ${stats.linesOfCode}`);
  console.log(`  GitHub Age:    ${stats.accountAge}`);
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
