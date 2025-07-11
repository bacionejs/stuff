> ⚠️ **Warning:** These are dev notes, not usage instructions.

## 🧩 Overview of the generation process

The data is a static JSON snapshot generated offline and updated periodically, enabling a dynamic interface without relying on a live backend.

The result of this process is a compact json file, which is then used to drive the UI.

### Extracts:

Game: `name` (same as `html_url` slug)

Play: `homepage`

Source: `html_url`

Author: 
- repo `parent`
- or first word after last occurrence of *by* in the `description`
- otherwise *unknown*.

Year:
- first year in the `description` that not found in the name, unless there are no other
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
    })
    const entry = selectRepoFields(full)
    repoData.push(entry)
    console.log(`✅ ${i + 1}: ${entry.full_name}`)
  } catch (err) {
    console.warn(`⚠️ Error on ${repo.name}: ${err.message}`)
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
