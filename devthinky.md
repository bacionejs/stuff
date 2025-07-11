> ⚠️ **Warning:** These are dev notes, not usage instructions.

## 🧩 Overview of the generation process

The data is a static JSON snapshot generated offline and updated periodically, enabling a dynamic interface without relying on a live backend.

The result of this process is a compact json file, which is then used to drive the UI.

### Extracts:

- `.js`, `.ts`, `.html`, and `.htm`.
- Non-encoded data
- alphanumeric/underscore tokens

```js
const checkModules = async () => {
  try {
    const fs = await import("fs");
    const cp = await import("child_process");
    const { Octokit } = await import("@octokit/rest");
    const pLimit = await import("p-limit");
    const { promisify } = await import("util");

    return {
      mkdirSync: fs.mkdirSync,
      existsSync: fs.existsSync,
      rmSync: fs.rmSync,
      exec: cp.exec,
      Octokit,
      pLimit: pLimit.default, // p-limit exports as default
      promisify
    };
  } catch (e) {
    console.error("❌ Required node modules are missing.");
    console.error("👉 Run this to install them:\n   npm install @octokit/rest p-limit");
    process.exit(1);
  }
};

const start = async () => {
  const {
    mkdirSync, existsSync, rmSync, exec,
    Octokit, pLimit, promisify
  } = await checkModules();

  const GITHUB_ORG = "js13kGames";
  const ZIP_DIR = "zips";
  const UNZIP_DIR = "unzipped";
  const MAX_PARALLEL = 10;

  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN || undefined,
  });

  const EXCLUDED = new Set([
    "js13kgames.com", "js13kgames.com-legacy", "js13kserver", "js-game-server", "games",
    "resources", "entry", "bot", "web", "community", "blog", "js13kBreakouts", "Chain-Reaction"
  ]);

  const run = promisify(exec);
  const failedDownloads = [];
  const failedUnzips = [];
  const skippedDownloadNames = [];
  const skippedUnzipNames = [];
  let skippedDownloads = 0;
  let skippedUnzips = 0;
  const startTime = Date.now();

  const getRate = async () => {
    const { data } = await octokit.rateLimit.get();
    const { limit, used, remaining, reset } = data.rate;
    return { limit, used, remaining, reset };
  };

  const getAllRepos = async () => {
    const options = {
      org: GITHUB_ORG,
      type: "public",
      per_page: 100,
    };
    const repos = await octokit.paginate(octokit.repos.listForOrg, options);
    return repos.filter(r => !r.fork && !EXCLUDED.has(r.name));
  };

  const downloadZip = async (repoName) => {
    const outPath = `${ZIP_DIR}/${repoName}.zip`;
    if (existsSync(outPath)) {
      console.log(`⚠️ Skipping download: ${repoName}`);
      skippedDownloads++;
      skippedDownloadNames.push(repoName);
      return;
    }
    console.log(`⬇️ Downloading ${repoName}...`);
    const mainUrl = `https://github.com/${GITHUB_ORG}/${repoName}/archive/refs/heads/main.zip`;
    const masterUrl = `https://github.com/${GITHUB_ORG}/${repoName}/archive/refs/heads/master.zip`;
    const cmd = `curl -sfL "${mainUrl}" -o "${outPath}" || curl -sfL "${masterUrl}" -o "${outPath}"`;

    try {
      await run(cmd);
      console.log(`✅ Downloaded: ${repoName}`);
    } catch {
      console.warn(`❌ Failed to download: ${repoName}`);
      rmSync(outPath, { force: true });
      failedDownloads.push(repoName);
    }
  };

  const unzipRepo = async (repoName) => {
    const zipPath = `${ZIP_DIR}/${repoName}.zip`;
    const outDir = `${UNZIP_DIR}/${repoName}`;
    if (!existsSync(zipPath)) return;
    if (existsSync(outDir)) {
      console.log(`⚠️ Skipping unzip: ${repoName}`);
      skippedUnzips++;
      skippedUnzipNames.push(repoName);
      return;
    }

    console.log(`📂 Unzipping ${repoName}...`);
    mkdirSync(outDir, { recursive: true });

    const cmd = `unzip -q "${zipPath}" -d "${outDir}"`;
    try {
      await run(cmd);
      await run(`find "${outDir}" -type f ! -iname '*.js' ! -iname '*.ts' ! -iname '*.html' ! -iname '*.htm' -delete`);
      console.log(`✅ Unzipped: ${repoName}`);
    } catch {
      console.warn(`❌ Failed to unzip: ${repoName}`);
      rmSync(outDir, { recursive: true, force: true });
      failedUnzips.push(repoName);
    }
  };

  const printSummary = async (reposCount = 0, rateBefore = null, rateAfter = null, partial = false) => {
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    if (!rateAfter && rateBefore) rateAfter = await getRate();

    console.log(partial ? "\n📊 Partial Summary:" : "\n📊 Summary:");
    if (reposCount) console.log(`✔️ Total fetched:      ${reposCount}`);
    console.log(`⚠️ Skipped downloads: ${skippedDownloads}`);
    if (skippedDownloadNames.length) console.log("   ↳", skippedDownloadNames.join(", "));
    console.log(`⚠️ Skipped unzips:    ${skippedUnzips}`);
    if (skippedUnzipNames.length) console.log("   ↳", skippedUnzipNames.join(", "));
    console.log(`❌ Failed downloads:  ${failedDownloads.length}`);
    if (failedDownloads.length) console.log("   ↳", failedDownloads.join(", "));
    console.log(`❌ Failed unzips:     ${failedUnzips.length}`);
    if (failedUnzips.length) console.log("   ↳", failedUnzips.join(", "));
    console.log(`⏱️ Time elapsed:      ${elapsedSec} seconds`);
    if (rateBefore && rateAfter) {
      console.log(`🔢 API calls used:    ${rateAfter.used - rateBefore.used}`);
      console.log(`🔢 Remaining:         ${rateAfter.remaining} / ${rateAfter.limit}`);
      console.log(`🔁 Resets at:         ${new Date(rateAfter.reset * 1000).toLocaleString()}`);
    }
    if (!partial) console.log("🎉 Done!");
  };

  const main = async ({ limit = 0 } = {}) => {
    const rateBefore = await getRate();

    mkdirSync(ZIP_DIR, { recursive: true });
    mkdirSync(UNZIP_DIR, { recursive: true });

    let repos = await getAllRepos();
    console.log(`📦 Total repos fetched: ${repos.length}`);
    if (limit > 0) repos = repos.slice(0, limit);

    const limitConcurrency = pLimit(MAX_PARALLEL);

    await Promise.all(repos.map(r => limitConcurrency(() => downloadZip(r.name))));
    await Promise.all(repos.map(r => limitConcurrency(() => unzipRepo(r.name))));

    const rateAfter = await getRate();
    await printSummary(repos.length, rateBefore, rateAfter);
  };

  process.on("SIGINT", async () => {
    console.log("\n🛑 Interrupted with Ctrl+C");
    await printSummary(0, null, null, true);
    process.exit(130);
  });

  main().catch(err => {
    console.error("❌ Unhandled error:", err);
    process.exit(1);
  });
};

start();
```

```js
const fs = require("fs");
const path = require("path");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const tokenRegex = /\b[a-zA-Z0-9_]+\b/g;

function looksBinary(buf) {
  let nonAscii = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32) || c > 126) nonAscii++;
  }
  return nonAscii / buf.length > 0.2;
}

function getRepoName(filePath) {
  const parts = filePath.split(path.sep);
  const i = parts.indexOf("unzipped");
  return i !== -1 && parts[i + 1] ? parts[i + 1] : null;
}

if (!isMainThread) {
  // ==== WORKER CODE ====
  const tokenToRepos = new Map();
  const repoSet = new Set();
  let totalChars = 0;
  let removedBase64Blobs = 0;

  for (const file of workerData.files) {
    try {
      const stat = fs.statSync(file);
      if (stat.size > 500_000) continue;

      const buf = fs.readFileSync(file);
      if (looksBinary(buf)) continue;

      let text = buf.toString("utf8");
      totalChars += text.length;

      const repo = getRepoName(file);
      if (!repo) continue;
      repoSet.add(repo);

      text = text.replace(/base64,[A-Za-z0-9+/=]+/g, () => { removedBase64Blobs++; return " "; });
      text = text.replace(/["'`][A-Za-z0-9+/=]{40,}["'`]/g, () => { removedBase64Blobs++; return " "; });
      text = text.replace(/\batob\s*\(\s*["'`][A-Za-z0-9+/=]{40,}["'`]\s*\)/g, () => { removedBase64Blobs++; return " "; });
      text = text.replace(/["'`][A-Za-z0-9_@#%$*^!<>?:;.,\\|~`-]{40,}["'`]/g, () => { removedBase64Blobs++; return " "; });

      const tokens = text.match(tokenRegex);
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

  const result = {
    totalChars,
    removedBase64Blobs,
    repos: [...repoSet],
    tokens: [...tokenToRepos.entries()].map(([token, set]) => [token, [...set]])
  };

  parentPort.postMessage(result);
  return;
}

// ==== MAIN THREAD CODE ====
const THREADS = 8;
const rootDir = "unzipped";

function walk(dir) {
  let files = [];
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        files = files.concat(walk(fullPath));
      } else {
        files.push(fullPath);
      }
    } catch {}
  }
  return files;
}

function splitArray(array, parts) {
  const out = [];
  const size = Math.ceil(array.length / parts);
  for (let i = 0; i < parts; i++) out.push(array.slice(i * size, (i + 1) * size));
  return out;
}

function runWorker(files) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { files }
    });
    worker.on("message", resolve);
    worker.on("error", reject);
    worker.on("exit", code => {
      if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
    });
  });
}

(async () => {
  if (!fs.existsSync(rootDir)) {
    console.error(`ERROR: ${rootDir} does not exist.`);
    process.exit(1);
  }

  const allFiles = walk(rootDir);
  console.log(`Step 1: Found ${allFiles.length} files`);

  const chunks = splitArray(allFiles, THREADS);
  const results = await Promise.all(chunks.map(runWorker));

  const tokenToRepos = new Map();
  const repoSet = new Set();
  let totalChars = 0;
  let removedBase64Blobs = 0;

  for (const r of results) {
    totalChars += r.totalChars;
    removedBase64Blobs += r.removedBase64Blobs;
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
    tokens: [...tokenToRepos.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([token, repos]) => [
        token,
        [...repos].map(r => repoIndexMap.get(r)).sort((a, b) => a - b)
      ])
  };

  fs.writeFileSync("thinky.json", JSON.stringify(output));

  console.log(`Step 2: Removed ${removedBase64Blobs} base64 blobs`);
  console.log(`Step 3: Unique tokens: ${tokenToRepos.size}`);
  console.log(`Step 4: Repositories indexed: ${sortedRepos.length}`);
  console.log(`Step 5: Saved thinky.json`);
})();
```
