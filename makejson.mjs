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
const LAST_UPDATED_FILE = ".repo-last-updated.txt";
const MAX_PARALLEL = 10;
const THREADS = 8;

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN || undefined });
const run = promisify(exec);

const EXCLUDED = new Set([
  "js13kgames.com", "js13kgames.com-legacy", "js13kserver", "js-game-server", "games", "resources", "entry",
  "bot", "web", "community", "blog", "js13kBreakouts", "Chain-Reaction", "vote", "kilo", "kilo-test",
  "events", "glitchd", "Triska", "The-Maze", "Anti_Virus", "__OFF_THE_LINE__", "Out_Of_Memory",
  "snakee", "A.W.E.S.O.M.E"
]);

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

function saveCachedTimestamp(timestamp) {
  try {
    writeFileSync(LAST_UPDATED_FILE, timestamp);
  } catch {}
}

function readCachedTimestamp() {
  try {
    return readFileSync(LAST_UPDATED_FILE, "utf8");
  } catch {
    return null;
  }
}

async function getLatestUpdateTimestamp() {
  try {
    const res = await octokit.repos.listForOrg({
      org: GITHUB_ORG,
      per_page: 1,
      sort: "updated",
      direction: "desc"
    });
    return res.data[0]?.updated_at || null;
  } catch (e) {
    console.error("Failed to fetch latest update timestamp:", e);
    return null;
  }
}

async function getRepos() {
  const options = { org: GITHUB_ORG, type: "public", per_page: 100 };
  const all = await octokit.paginate(octokit.repos.listForOrg, options);
  return all.filter(repo => !EXCLUDED.has(repo.name));
}

async function runWorker(files) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { files } });
    worker.on("message", resolve);
    worker.on("error", reject);
    worker.on("exit", code => {
      if (code !== 0) reject(new Error("Worker exited with code " + code));
    });
  });
}

async function extractTokens() {
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

async function generateGamesJson(repos) {
  const p = pLimit(MAX_PARALLEL);
  const repoData = [];

  await Promise.all(
    repos.map((repo, i) =>
      p(async () => {
        try {
          const full = (await octokit.repos.get({ owner: repo.owner.login, repo: repo.name })).data;
          const parent = full.parent?.owner?.login;
          if (!parent) {
            console.warn("Skipping " + repo.name + ": no parent.");
            return;
          }

          repoData.push({
            name: full.name,
            stars: full.parent?.stargazers_count || full.stargazers_count,
            author: parent,
            year: extractYear(full.description, full.created_at)
          });
          console.log((i + 1) + ": " + full.name);
        } catch (e) {
          console.warn("Error " + repo.name + ": " + e.message);
        }
      })
    )
  );

  writeFileSync(GAMES_FILE, JSON.stringify(repoData, null, 2));
  console.log("Saved " + GAMES_FILE);
}

async function downloadZip(repoName) {
  const out = `${ZIP_DIR}/${repoName}.zip`;
  if (existsSync(out)) return;
  const urls = [
    `https://github.com/${GITHUB_ORG}/${repoName}/archive/refs/heads/main.zip`,
    `https://github.com/${GITHUB_ORG}/${repoName}/archive/refs/heads/master.zip`
  ];
  try {
    await run(`curl -sfL "${urls[0]}" -o "${out}" || curl -sfL "${urls[1]}" -o "${out}"`);
    console.log("Downloaded: " + repoName);
  } catch {
    rmSync(out, { force: true });
  }
}

async function unzipRepo(repoName) {
  const zip = `${ZIP_DIR}/${repoName}.zip`;
  const out = `${UNZIP_DIR}/${repoName}`;
  if (!existsSync(zip) || existsSync(out)) return;
  mkdirSync(out, { recursive: true });
  try {
    await run(`unzip -q "${zip}" -d "${out}"`);
    await run(`find "${out}" -type f ! -iname '*.js' ! -iname '*.ts' ! -iname '*.html' ! -iname '*.htm' -delete`);
  } catch {
    rmSync(out, { recursive: true, force: true });
  }
}

async function main() {
  console.log("Checking for updates...");
  mkdirSync(ZIP_DIR, { recursive: true });
  mkdirSync(UNZIP_DIR, { recursive: true });

  const previous = readCachedTimestamp();
  const latest = await getLatestUpdateTimestamp();

  if (previous && latest && previous === latest) {
    console.log("No repository updates since last run.");
    return;
  }

  console.log("Changes detected. Proceeding...");
  saveCachedTimestamp(latest);

  let repos = await getRepos();
//  repos = repos.slice(0, 10); // Uncomment to limit for testing

  const limiter = pLimit(MAX_PARALLEL);
  await Promise.all(repos.map(r => limiter(() => downloadZip(r.name))));
  await Promise.all(repos.map(r => limiter(() => unzipRepo(r.name))));

  await extractTokens();
  await generateGamesJson(repos);
}

process.on("SIGINT", () => {
  console.log("\nInterrupted");
  process.exit(130);
});

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
