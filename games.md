
> ⚠️ **Warning:** These are dev notes, not usage instructions.

A script generates a JSON snapshot, periodically, enabling a dynamic interface without relying on a live backend.

### Extracts:

Name: `name` (same as `html_url` slug)

Play: `homepage`

Source: `html_url`

authors: an array of 1 to n authors
→ Check `description` field
  - If exactly 1 word boundary "by" (e.g. "by @foo" or "by JohnDoe"):
    - Get string after "by" up to end of string ($) or period (.)
    - If it contains @mentions → allow many authors (strip @)
    - Else if it's exactly 1 word → use it
→ Else check `parent` field
→ Else use `contributor` field

year:
  → If "a js13kGames" in `description`, get the number immediately after
  → Else, use first 4 digits of `created_at`

The `parent` field is unreliable because participants might delete their repositories.

The `created_at` field is unreliable because some games got forked in the year of the cat.

```js
import { Octokit } from "@octokit/rest";
import fs from "fs";
import pLimit from "p-limit";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OUTPUT_FILE = "games.json";
const LIMIT = 0;
const MAX_PARALLEL = 10;

const EXCLUDED = new Set([
  "js13kgames.com",
  "js13kgames.com-legacy",
  "js13kserver",
  "js-game-server",
  "games",
  "resources",
  "entry",
  "bot",
  "web",
  "community",
  "blog",
  "js13kBreakouts",
  "Chain-Reaction",
  "vote",
  "kilo",
  "kilo-test",
  "events",
  "glitchd"
]);

let repoData = [];
let shuttingDown = false;

process.on("SIGINT", () => {
  if (!shuttingDown) {
    shuttingDown = true;
    console.log("\n🛑 CTRL-C detected. Writing partial output to", OUTPUT_FILE);
    writeLog();
    process.exit();
  }
});

function writeLog() {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(repoData, null, 2), "utf8");
}

function selectRepoFields(repo) {
  return {
    name: repo.name,
    play: repo.homepage,
    source: repo.html_url
  };
}

async function getRepos() {
  const options = {
    org: "js13kGames",
    type: "public",
    per_page: LIMIT > 0 ? LIMIT : 100
  };
  const allRepos = LIMIT > 0
    ? (await octokit.repos.listForOrg(options)).data.slice(0, LIMIT)
    : await octokit.paginate(octokit.repos.listForOrg, options);
  return allRepos.filter(repo => !EXCLUDED.has(repo.name));
}

function extractAuthors(description) {
  if (!description) return null;
  const match = description.match(/\bby\b/i);
  if (!match) return null;

  // Take the part after "by" up to the period or end
  const afterBy = description.split(/\bby\b/i)[1].split(".")[0].trim();

  // Grab all GitHub @mentions in the form @user or [@user](...)
  const mentions = [...afterBy.matchAll(/@([a-z0-9_-]+)/gi)].map(m => m[1]);

  // Fallback: try to extract a single author name (non-@) if no mentions
  if (mentions.length === 0) {
    const fallback = afterBy.split(/[,&]/)[0].trim().split(/\s+/);
    if (fallback.length === 1 && fallback[0]) return [fallback[0]];
    return null;
  }

  return mentions;
}

function extractYear(description, created_at) {
  const match = description?.match(/a js13kGames\s+(\d{4})/i);
  if (match) return parseInt(match[1]);
  return parseInt(created_at.slice(0, 4));
}

async function processRepo(i, repo) {
  try {
    const { data: full } = await octokit.repos.get({
      owner: repo.owner.login,
      repo: repo.name
    });

    const entry = selectRepoFields(full);
    let authors = ["unknown"];

    if (full.description) {
      const descAuthors = extractAuthors(full.description);
      if (descAuthors) authors = descAuthors;
    }

    if (authors[0] === "unknown" && full.parent?.full_name?.includes("/")) {
      authors = [full.parent.full_name.split("/")[0]];
    }

    if (authors[0] === "unknown") {
      const { data: contributors } = await octokit.repos.listContributors({
        owner: repo.owner.login,
        repo: repo.name,
        per_page: 1
      });
      if (contributors.length > 0) {
        authors = [contributors[0].login];
      }
    }

    entry.authors = authors;
    entry.year = extractYear(full.description, full.created_at);
    repoData.push(entry);

    console.log(`✅ ${i + 1}: ${repo.name} by ${authors.join(", ")}`);
  } catch (err) {
    console.warn(`⚠️ Error on ${repo.name}: ${err.message}`);
  }
}

async function buildLog() {
  const rate = await octokit.rateLimit.get();
  console.log("⏱️ GitHub Rate Limit:", rate.data.rate);
  console.log("⏳ Resets at:", new Date(rate.data.rate.reset * 1000).toLocaleString());
  const repos = await getRepos();
  console.log("📦 Total repos fetched (after exclusions):", repos.length);
  const limit = pLimit(MAX_PARALLEL);
  const tasks = repos.map((repo, i) => limit(() => processRepo(i, repo)));
  await Promise.all(tasks);
  writeLog();
  console.log("✅ Done. Output saved to", OUTPUT_FILE);
}

buildLog().catch(err => {
  console.error("🔥 Unhandled error:", err);
  writeLog();
});
```
