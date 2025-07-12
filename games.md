> ⚠️ **Warning:** These are dev notes, not usage instructions.

A script generates a JSON snapshot, periodically, enabling a dynamic interface without relying on a live backend.

### Extracts:

Game: `name` (same as `html_url` slug)

Play: `homepage`

Source: `html_url`

Author: 
- @names after last occurrence of *by* in the `description`
- or repo `parent`
- otherwise first `contributor`.

Year:
- first year in the `description` not found in the name, unless there are no other
- otherwise `created_at`

The `parent` field is unreliable because participants might delete their repositories.

The `created_at` field is unreliable because some games got forked in the year of the cat.

```js
import { Octokit } from "@octokit/rest"
import fs from "fs"
import pLimit from "p-limit"

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
const OUTPUT_FILE = "games.json"
const LIMIT = 0
const MAX_PARALLEL = 10

const EXCLUDED_NAMES = new Set([
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
  "Chain-Reaction"
])

let repoData = []

function writeLog() {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(repoData, null, 2), "utf8")
}

function selectRepoFields(repo) {
  return {
    name: repo.name,
    description: repo.description,
    homepage: repo.homepage,
    created_at: repo.created_at,
    html_url: repo.html_url,
    parent: repo.parent?.full_name
  }
}

async function getRepos() {
  const options = {
    org: "js13kGames",
    type: "public",
    per_page: LIMIT > 0 ? LIMIT : 100
  }
  const allRepos = LIMIT > 0
    ? (await octokit.repos.listForOrg(options)).data.slice(0, LIMIT)
    : await octokit.paginate(octokit.repos.listForOrg, options)
  return allRepos.filter(repo => !EXCLUDED_NAMES.has(repo.name))
}

async function processRepo(i, repo) {
  try {
    const { data: full } = await octokit.repos.get({
      owner: repo.owner.login,
      repo: repo.name
    });

    const entry = selectRepoFields(full);

    let author = "unknown";

    // Try to extract author from parent
    if (entry.parent && entry.parent.includes("/")) {
      author = entry.parent.split("/")[0];
    } else if (entry.description) {
      // Try to extract from description
      let parts = entry.description.split(/\bby\b/i);
      if (parts.length > 1) {
        let match = parts[parts.length - 1].match(/@?([^\s.,!?]+)/);
        if (match) {
          author = match[1];
        }
      }
    }

    // Fallback: fetch contributors ONLY if still unknown
    if (author === "unknown") {
      const { data: contributors } = await octokit.repos.listContributors({
        owner: repo.owner.login,
        repo: repo.name,
        per_page: 1
      });
      if (contributors.length > 0) {
        author = contributors[0].login;
      }
    }

    entry.author = author;
    repoData.push(entry);

    console.log(`✅ ${i + 1}: ${repo.name} by ${entry.author}`);
  } catch (err) {
    console.warn(`⚠️ Error on ${repo.name}: ${err.message}`);
  }
}

async function buildLog() {
  const rate = await octokit.rateLimit.get()
  console.log("⏱️ GitHub Rate Limit:", rate.data.rate)
  console.log("⏳ Resets at:", new Date(rate.data.rate.reset * 1000).toLocaleString())
  const repos = await getRepos()
  console.log("📦 Total repos fetched (after exclusions):", repos.length)
  const limit = pLimit(MAX_PARALLEL)
  const tasks = repos.map((repo, i) => limit(() => processRepo(i, repo)))
  await Promise.all(tasks)
  writeLog()
  console.log("✅ Done. Output saved to", OUTPUT_FILE)
}

buildLog()
```
