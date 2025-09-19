import { mkdirSync, existsSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { Octokit } from "@octokit/rest";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import pLimit from "p-limit";

const GITHUB_ORG = "js13kGames";
const ZIP_DIR = "zips";
const UNZIP_DIR = "unzipped";
const TOKENS_FILE = "tokens.json";
const GAMES_FILE = "games.json";
const MAX_PARALLEL = 10;
const THREADS = 8;

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN || undefined });
const run = promisify(exec);

if (!isMainThread) {
  function getRepoName(filePath) {
    const parts = filePath.split(path.sep);
    const i = parts.indexOf("unzipped");
    return i !== -1 && parts[i + 1] ? parts[i + 1] : null;
  }
  const tokenToRepos = new Map();
  const repoSet = new Set();
  for (const file of workerData.files) {
    try {
      const stat = statSync(file);
      if (stat.size > 500000) continue;
      const buf = readFileSync(file);
      let text = buf.toString("utf8");
      const repo = getRepoName(file);
      if (!repo) continue;
      repoSet.add(repo);
      const patterns = [
        /base64,[A-Za-z0-9+/=]+/g,
        /["'`][A-Za-z0-9+/=]{40,}["'`]/g,
        /["'`][A-Za-z0-9_@#%$*^!<>?:;.,\\|~`-]{40,}["'`]/g
      ];
      for (const pattern of patterns) {
        text = text.replace(pattern, " ");
      }
      const tokens = text.match(/\b[a-zA-Z0-9_]+\b/g);
      if (tokens) {
        const used = new Set();
        for (const token of tokens) {
          if (token === token.toUpperCase() && token.length > 2) continue;
          used.add(token);
        }
        for (const token of used) {
          if (!tokenToRepos.has(token)) tokenToRepos.set(token, new Set());
          tokenToRepos.get(token).add(repo);
        }
      }
    } catch {}
  }
  parentPort.postMessage({
    repos: [...repoSet],
    tokens: [...tokenToRepos.entries()].map(([token, set]) => [token, [...set]])
  });
  process.exit(0);
}

function walk(dir) {
let files = [];
for (const entry of readdirSync(dir)) {
  const full = path.join(dir, entry);
  try {
    const stat = statSync(full);
    if (stat.isDirectory()) files = files.concat(walk(full));
    else files.push(full);
  } catch {}
}
return files;
}

function splitArray(arr, parts) {
const size = Math.ceil(arr.length / parts);
return Array.from({ length: parts }, (_, i) => arr.slice(i * size, (i + 1) * size));
}

async function runWorker(files) {
return new Promise((resolve, reject) => {
  const worker = new Worker(new URL(import.meta.url), { workerData: { files } });
  worker.on("message", resolve);
  worker.on("error", reject);
  worker.on("exit", code => { if (code !== 0) reject(new Error("Worker exited with code " + code)); });
});
}

async function getRepos() {
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) throw new Error("Set GITHUB_TOKEN in environment");
const url = "https://api.github.com/repos/js13kGames/games/git/trees/main?recursive=1";
const res = await fetch(url, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
const data = await res.json();
// filter top-level directories under "games"
const dirs = data.tree
  .filter(entry => entry.type === "tree" && /^games\/[^/]+$/.test(entry.path))
  .map(entry => entry.path.replace(/^games\//, ""));
return dirs;
}

async function generateTokens() {
const files = walk(UNZIP_DIR);
const chunks = splitArray(files, THREADS);
const results = await Promise.all(chunks.map(runWorker));
const tokenToRepos = new Map();
const repoSet = new Set();
for (const r of results) {
  for (const repo of r.repos) repoSet.add(repo);
  for (const [token, repos] of r.tokens) {
    if (!tokenToRepos.has(token)) tokenToRepos.set(token, new Set());
    for (const repo of repos) tokenToRepos.get(token).add(repo);
  }
}
const sortedRepos = [...repoSet].sort();
const repoIndexMap = new Map();
sortedRepos.forEach((repo, i) => repoIndexMap.set(repo, i));
const output = {
  repos: sortedRepos,
  tokens: [...tokenToRepos.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([token, repos]) => [
    token,
    [...repos].map(r => repoIndexMap.get(r)).sort((a, b) => a - b)
  ])
};
writeFileSync(TOKENS_FILE, JSON.stringify(output));
console.log("Saved " + TOKENS_FILE);
}

function extractYear(description, created_at) {
const match = description && description.match(/a js13kGames\s+(\d{4})/i);
return match ? parseInt(match[1]) : parseInt(created_at.slice(0, 4));
}

async function generateGames(repos) {
const p = pLimit(MAX_PARALLEL);
const repoData = [];
await Promise.all(
  repos.map((repo, _) =>
    p(async () => {
      try {
        const full = (await octokit.repos.get({ owner: repo.owner.login, repo: repo.name })).data;
        const parent = full.parent?.owner?.login;
        if (!parent) { return; }//skip orphans
        repoData.push({
          name: full.name,
          stars: full.parent?.stargazers_count || full.stargazers_count,
          author: parent,
          year: extractYear(full.description, full.created_at)
        });
      } catch (e) {
        console.warn("Error " + repo.name + ": " + e.message);
      }
    })
  )
);
writeFileSync(GAMES_FILE, JSON.stringify(repoData, null, 2));
console.log("Saved " + GAMES_FILE);
return repoData.map(r => r.name);
}

async function download(repo) {
const out = `${ZIP_DIR}/${repo.name}.zip`;
if (existsSync(out)) return false;
const urls = [
  `https://github.com/${GITHUB_ORG}/${repo.name}/archive/refs/heads/main.zip`,
  `https://github.com/${GITHUB_ORG}/${repo.name}/archive/refs/heads/master.zip`
];
try {
  await run(`curl -sfL "${urls[0]}" -o "${out}" || curl -sfL "${urls[1]}" -o "${out}"`);
  return true;
} catch {
  rmSync(out, { force: true });
  return false;
}
}

async function unzip(repo) {
const zip = `${ZIP_DIR}/${repo.name}.zip`;
const out = `${UNZIP_DIR}/${repo.name}`;
if (!existsSync(zip)) return false;
if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
try {
  await run(`unzip -q "${zip}" -d "${out}"`);
  await run(`find "${out}" -type f ! -iname '*.js' ! -iname '*.ts' ! -iname '*.html' ! -iname '*.htm' -delete`);
  return true;
} catch {
  rmSync(out, { recursive: true, force: true });
  return false;
}
}

async function rate() {
const { data } = await octokit.rateLimit.get();
console.log(`Github api calls remaining: ${data.rate.remaining}/${data.rate.limit}`);
}

async function main() {
await rate(); 
console.log("Warning: consumes 1 github api call per repo");
console.log("Warning: as of 2025, download was 2.4G");
console.log("Each step takes several minutes");
mkdirSync(ZIP_DIR, { recursive: true });
mkdirSync(UNZIP_DIR, { recursive: true });
const limiter = pLimit(MAX_PARALLEL);
console.log("Getting list"); const repos = await getRepos(); 
console.log("Getting metadata"); await generateGames(repos);
const games = JSON.parse(readFileSync(GAMES_FILE, "utf8")).map(r => r.name);
console.log("Downloading source"); await Promise.all( games.map(name => limiter(() => download({ name }))));
console.log("Unzipping"); await Promise.all( games.map(name => limiter(() => unzip({ name }))));
console.log("Generating search tokens"); await generateTokens();
console.log("Done");
await rate(); 
}






process.on("SIGINT", () => { console.log("\nInterrupted"); process.exit(130); });
main().catch(err => { console.error("Fatal:", err); process.exit(1); });



/*
 * Parent (forks without parent are skipped)
 * - exists: if the owner deleted, then it probable wasn't great anyway
 * - stars: sort field, ensures best are at top
 * - owner: repo owner
 *
 * Use case: help people find tech (webgl, sonant, etc) examples used by high-rated repos
 *
 * */





