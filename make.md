# Thinky

> ⚠️ This is **not** a guide or tutorial. This is just how I built and wired everything together. If you want to reuse it, you’ll need to adapt it to your own needs.

Thinky is a system for analyzing which GitHub repositories (specifically js13kGames entries) use which tokens or keywords. It downloads zip files of each repo, extracts them, removes junk, tokenizes the source, and builds a JSON index that powers a lightweight browser UI for exploring who uses what.

---

## Step-by-step Overview

1. **List** repositories in `repos.txt` — one name per line.
2. **Download** zips from GitHub with `getzip.sh`.
3. **Unzip** them all with `unzipall.sh`.
4. **Run** `extract.js` to:
   - tokenize all source files,
   - skip base64 blobs and binary files,
   - use workers for speed,
   - write `thinky.json` containing the token-repo map.
5. **Open** `thinky.html` to search for tokens and see which repos use them.

---

## Included Files

### 📁 `getzip.sh`

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

---

### 📁 `unzipall.sh`

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
  else
    echo "⚠️ Failed to unzip $name" | tee -a "$logfile"
    echo "$name" >> "$failfile"
    rm -rf "$out"
  fi
done
```

---

### 📁 `extract.js`

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

---

### 📁 `worker.js`

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

    text = text.replace(/base64,[A-Za-z0-9+/=]+/g, () => { removedBase64Blobs++; return " "; });
    text = text.replace(/["'`][A-Za-z0-9+/=]{40,}["'`]/g, () => { removedBase64Blobs++; return " "; });
    text = text.replace(/\batob\s*\s*["'`][A-Za-z0-9+/=]{40,}["'`]\s*/g, () => { removedBase64Blobs++; return " "; });
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
```

---

### 📁 `thinky.html`

```html
<html>
<script>
const e = (t, p) => {const x = document.createElement(t); if (p) for (const [k, v] of Object.entries(p)) x[k] = v; return x};
const style = () => {
  const s = e('style');
  s.textContent = `
body{font-size:10px;padding:1em}
ul{list-style:none;padding:0;}
li{padding:0.2em 0}
span.repo{color:#669;cursor:pointer}
#tokens{margin:1em 0 1em 0;color:#555;font-size:5px;height:100px; overflow:auto; resize:none;}
#filter{}
#counts{color:green;font-size:0.9em;margin:1em 0 1em 1em}`;
  document.head.appendChild(s)
};
const main = () => {
document.title = 'Thinky'; style();
const desc = e('div');
desc.innerHTML = `Find <b>who</b> uses <b>what</b>, i.e. repos using sonant, zzfx, aframe, audiocontext, etc.  
<a href="https://github.com/bacionejs/stuff" target="_blank">README</a><br><br>`;
const filter = e('input', {
  placeholder: 'Loading data...',
  disabled: true
}, {id: 'filter'});
const counts = e('span', {id: 'counts'});
const tlist = e('div', {id: 'tokens'}), ul = e('ul');
document.body.append(desc, filter, counts, tlist, ul);
let tokens = {}, repos = [];
fetch("thinky.json").then(r => r.json()).then(data => {
  repos = data.repos;
  for (const [t, arr] of data.tokens) tokens[t] = arr;
  ul.onclick = e => {
    const s = e.target;
    if (s.className === 'repo') window.open('https://github.com/js13kgames/' + s.textContent, '_blank');
  };
  filter.disabled = false;
  filter.placeholder = 'FILTER';
  filter.oninput = () => {
    const f = filter.value; if (!f) {tlist.textContent = ''; ul.textContent = ''; counts.textContent = ''; return;}
    const sensitive = /[A-Z]/.test(f);
    const matchedTokens = [], matchedRepos = new Set();
    for (const t in tokens) {
      const match = sensitive ? t.startsWith(f) : t.toLowerCase().startsWith(f.toLowerCase());
      if (match) {matchedTokens.push(t); for (const n of tokens[t]) matchedRepos.add(n)}
    }
    counts.textContent = matchedTokens.length + " tokens, " + matchedRepos.size + " repos";
    tlist.textContent = matchedTokens.join(' ');
    ul.textContent = '';
    [...matchedRepos].sort((a, b) => a - b).forEach(n => {
      const name = repos[n] || `[${n}]`, li = e('li'), span = e('span', {textContent: name, className: 'repo'});
      li.appendChild(span); ul.appendChild(li);
    });
  };
});
};
onload = main;
</script>
</html>
```

---
