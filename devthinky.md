# Dev Notes for Thinky (`devthinky.md`)

⚠️ **Warning:** This is not a guide or set of instructions.  
This document is a retrospective on how the Thinky app was built — how repositories were downloaded, filtered, tokenized, and indexed for exploration.

---

## 🧩 Overview of the Four Files

1. **`getzip.sh`** – Downloads ZIP archives from GitHub repositories listed in `repos.txt`, trying both `main` and `master` branches. Skips already-downloaded files to avoid redundancy.

2. **`unzipall.sh`** – Extracts those ZIP archives to per-repo folders. Then immediately deletes everything that is not JavaScript, TypeScript, or HTML (`.js`, `.ts`, `.html`, `.htm`).

3. **`extract.js`** – Recursively walks all code files, splits them into batches, and distributes them to worker threads for parallel processing. Each worker extracts token data from its assigned files.

4. **`worker.js`** – Each worker removes base64 blobs from text content and uses regular expressions to extract identifiers and string literals. These tokens are mapped to their originating repository.

The result of this process is a compact file, `thinky.json`, which is then used by `Thinky.html` (formerly `Thinky.js`) to drive the search UI.

---

## 🔍 Token Extraction Details

- **Base64 Removal**  
  Long embedded data blobs like images or fonts are detected and removed with this regex:  
  ```js
  /["'`]data:[^"'`]{100,}["'`]/g
  ```

- **Token Matching**
  - JavaScript-style identifiers of length ≥ 3:  
    ```js
    /[_$a-zA-Z][_$a-zA-Z0-9]{2,}/g
    ```
  - String literals (single, double, or backtick quotes):  
    ```js
    /(['"`])((?:\\.|(?!\1).)*?)\1/g
    ```

- **Filter Rules**
  - Tokens like `if`, `return`, or `undefined` are excluded using a list of built-in keywords and Node.js module names.
  - Extracted strings are `eval`'d safely and included only if they're 3+ characters and alphanumeric.

---

## 🧵 Code Blocks

### `getzip.sh`

```bash
#!/bin/bash
mkdir -p zips
: > download.log
: > failures.txt
download() {
  name="$1"
  out="zips/${name}.zip"
  url_main="https://github.com/js13kGames/${name}/archive/refs/heads/main.zip"
  url_master="https://github.com/js13kGames/${name}/archive/refs/heads/master.zip"
  if [ -f "$out" ]; then
    echo "✔️ Skipping $name" | tee -a download.log
    return
  fi
  echo "⬇️ Downloading $name..." | tee -a download.log
  if curl -sSfL "$url_main" -o "$out" 2>/dev/null; then
    echo "✅ Downloaded $name (main)" | tee -a download.log
  elif curl -sSfL "$url_master" -o "$out"; then
    echo "✅ Downloaded $name (master)" | tee -a download.log
  else
    echo "⚠️ Failed: $name" | tee -a download.log
    echo "$name" >> failures.txt
    rm -f "$out"
  fi
}
export -f download
cat repos.txt | xargs -n 1 -P 10 -I{} bash -c 'download "$@"' _ {}
```

### `unzipall.sh`

```bash
#!/bin/bash
mkdir -p unzipped
logfile="unzip.log"
failfile="unzip-failures.txt"
: > "$logfile"
: > "$failfile"
for zip in zips/*.zip; do
  name=$(basename "$zip" .zip)
  out="unzipped/$name"
  if [ -d "$out" ]; then
    echo "✔️ Skipping $name" | tee -a "$logfile"
    continue
  fi
  echo "📂 Unzipping $name..." | tee -a "$logfile"
  mkdir -p "$out"
  if unzip -q "$zip" -d "$out"; then
    echo "✅ Unzipped $name" | tee -a "$logfile"
    find "$out" -type f ! \( -iname '*.js' -o -iname '*.ts' -o -iname '*.html' -o -iname '*.htm' \) -delete
  else
    echo "⚠️ Failed to unzip $name" | tee -a "$logfile"
    echo "$name" >> "$failfile"
    rm -rf "$out"
  fi
done
```

### `extract.js`

```js
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const THREADS = 8;
const rootDir = "unzipped";
function walk(dir) {
  let files = [];
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) files = files.concat(walk(fullPath));
      else files.push(fullPath);
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
    const worker = new Worker("./worker.js", { workerData: { files } });
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

### `worker.js`

```js
const fs = require("fs");
const path = require("path");
const { parentPort, workerData } = require("worker_threads");

const tokenRegex = /\b[a-zA-Z_]+\b/g;

const tokenToRepos = new Map();
const repoSet = new Set();
let totalChars = 0;
let removedBase64Blobs = 0;

function getRepoName(filePath) {
  const parts = filePath.split(path.sep);
  const i = parts.indexOf("unzipped");
  return i !== -1 && parts[i + 1] ? parts[i + 1] : null;
}

function looksBinary(buf) {
  let nonAscii = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32) || c > 126) nonAscii++;
  }
  return nonAscii / buf.length > 0.2;
}

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

    text = text.replace(/base64,[A-Za-z0-9+/=]+/g, () => {
      removedBase64Blobs++;
      return " ";
    });
    text = text.replace(/["'`][A-Za-z0-9+/=]{40,}["'`]/g, () => {
      removedBase64Blobs++;
      return " ";
    });
    text = text.replace(/\batob\s*\s*["'`][A-Za-z0-9+/=]{40,}["'`]\s*/g, () => {
      removedBase64Blobs++;
      return " ";
    });
    text = text.replace(/["'`][A-Za-z0-9_@#%$*^!<>?:;.,\\|~`-]{40,}["'`]/g, () => {
      removedBase64Blobs++;
      return " ";
    });

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

// Serialize sets to arrays
const result = {
  totalChars,
  removedBase64Blobs,
  repos: [...repoSet],
  tokens: [...tokenToRepos.entries()].map(([token, set]) => [token, [...set]])
};

parentPort.postMessage(result);
```
