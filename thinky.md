> ⚠️ **Warning:** These are dev notes, not usage instructions.

A script generates a JSON snapshot, periodically, enabling a dynamic interface without relying on a live backend.

### Extracts:

- `.js`, `.ts`, `.html`, and `.htm`.
- Non-encoded data
- alphanumeric/underscore tokens

```js
import {mkdirSync,existsSync,rmSync,readdirSync,readFileSync,writeFileSync,statSync}from "fs";
import {exec}from "child_process";
import {Octokit}from "@octokit/rest";
import {promisify}from "util";
import {Worker,isMainThread,parentPort,workerData}from "worker_threads";
import path from "path";
import pLimit from "p-limit";

const GITHUB_ORG="js13kGames";
const ZIP_DIR="zips";
const UNZIP_DIR="unzipped";
const MAX_PARALLEL=10;
const THREADS=8;
const SKIP_FETCH=0;

const EXCLUDED=new Set([
"js13kgames.com","js13kgames.com-legacy","js13kserver","js-game-server",
"games","resources","entry","bot","web","community","blog",
"js13kBreakouts","Chain-Reaction"
]);

const octokit=new Octokit({auth:process.env.GITHUB_TOKEN||undefined});
const run=promisify(exec);











//─────WORKERCODE────────────────────────────────────────────────
if(!isMainThread){
function getRepoName(filePath){
  const parts=filePath.split(path.sep);
  const i=parts.indexOf("unzipped");
  return i!==-1&&parts[i+1]?parts[i+1]:null;
}
const tokenToRepos=new Map();
const repoSet=new Set();
let removedBase64Blobs=0;
for(const file of workerData.files){
  try{
    const stat=statSync(file);
    if(stat.size>500000)continue;
    const buf=readFileSync(file);
    let text=buf.toString("utf8");
    const repo=getRepoName(file);
    if(!repo)continue;
    repoSet.add(repo);
    const patterns=[
      /base64,[A-Za-z0-9+/=]+/g,
      /["'`][A-Za-z0-9+/=]{40,}["'`]/g,
      /["'`][A-Za-z0-9_@#%$*^!<>?:;.,\\|~`-]{40,}["'`]/g
    ];
    for(const pattern of patterns){
      text=text.replace(pattern,()=>{
        removedBase64Blobs++;
        return " ";
      });
    }
    const tokens=text.match(/\b[a-zA-Z0-9_]+\b/g);
    if(tokens){
      const used=new Set();
      for(const token of tokens){
        if(token===token.toUpperCase()&&token.length>2)continue;
        used.add(token);
      }
      for(const token of used){
        if(!tokenToRepos.has(token))tokenToRepos.set(token,new Set());
        tokenToRepos.get(token).add(repo);
      }
    }
  }catch{}
}
parentPort.postMessage({
  removedBase64Blobs,
  repos:[...repoSet],
  tokens:[...tokenToRepos.entries()].map(([token,set])=>[token,[...set]])
});
process.exit(0);
}










//─────MAINTHREADCODE────────────────────────────────────────────────
const failedDownloads=[];
const failedUnzips=[];
const skippedDownloadNames=[];
const skippedUnzipNames=[];
const startTime=Date.now();

async function getRate(){
const data=(await octokit.rateLimit.get()).data;
return data.rate;
}

async function getAllRepos(){
const options={org:GITHUB_ORG,type:"public",per_page:100};
const repos=await octokit.paginate(octokit.repos.listForOrg,options);
return repos.filter(r=>!EXCLUDED.has(r.name));
//return repos.filter(r => r.fork);
}

async function downloadZip(repoName){
const outPath=ZIP_DIR+"/"+repoName+".zip";
if(existsSync(outPath)){
skippedDownloadNames.push(repoName);
return false;
}
const mainUrl="https://github.com/"+GITHUB_ORG+"/"+repoName+"/archive/refs/heads/main.zip";
const masterUrl="https://github.com/"+GITHUB_ORG+"/"+repoName+"/archive/refs/heads/master.zip";
const cmd="curl -sfL '"+mainUrl+"' -o '"+outPath+"' || curl -sfL '"+masterUrl+"' -o '"+outPath+"'";
try{
await run(cmd);
return true;
}catch{
rmSync(outPath,{force:true});
failedDownloads.push(repoName);
return false;
}
}

async function unzipRepo(repoName){
const zipPath=ZIP_DIR+"/"+repoName+".zip";
const outDir=UNZIP_DIR+"/"+repoName;
if(!existsSync(zipPath)){
return false;
}
if(existsSync(outDir)){
skippedUnzipNames.push(repoName);
return false;
}
mkdirSync(outDir,{recursive:true});
const cmd="unzip -q '"+zipPath+"' -d '"+outDir+"'";
try{
await run(cmd);
await run("find '"+outDir+"' -type f ! -iname '*.js' ! -iname '*.ts' ! -iname '*.html' ! -iname '*.htm' -delete");
return true;
}catch{
rmSync(outDir,{recursive:true,force:true});
failedUnzips.push(repoName);
return false;
}
}

function walk(dir){
let files=[];
for(const entry of readdirSync(dir)){
  const fullPath=path.join(dir,entry);
  try{
    const stat=statSync(fullPath);
    if(stat.isDirectory())files=files.concat(walk(fullPath));
    else files.push(fullPath);
  }catch{}
}
return files;
}

function splitArray(array,parts){
const size=Math.ceil(array.length/parts);
return Array.from({length:parts},(_,i)=>array.slice(i*size,(i+1)*size));
}

function runWorker(files){
return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL(import.meta.url),{workerData:{files}});
  worker.on("message",resolve);
  worker.on("error",reject);
  worker.on("exit",code=>{
    if(code!==0)reject(new Error("Worker exited with code "+code));
  });
});
}

async function printSummary(reposCount,rateBefore,rateAfter){
const elapsedSec=Math.round((Date.now()-startTime)/1000);
if(!rateAfter&&rateBefore)rateAfter=await getRate();
if(reposCount>0){
  const newDownloads=reposCount - skippedDownloadNames.length;
  console.log("📥 ZIPs downloaded:"+newDownloads+"/"+reposCount);
}
if(failedDownloads.length)console.log("❌ Failed downloads:"+failedDownloads.join(", "));
if(failedUnzips.length)console.log("❌ Failed unzips:"+failedUnzips.join(", "));
if(rateBefore&&rateAfter){ console.log("seconds:"+elapsedSec+", calls:"+(rateAfter.used-rateBefore.used)+", remaining:"+rateAfter.remaining+"/"+rateAfter.limit)+", resets:"+new Date(rateAfter.reset*1000).toLocaleString(); }
}

async function extractTokens(){
const allFiles=walk(UNZIP_DIR);
console.log("📄 Files scanned: "+allFiles.length);
const chunks=splitArray(allFiles,THREADS);
const results=await Promise.all(chunks.map(runWorker));
const tokenToRepos=new Map();
const repoSet=new Set();
let removedBase64Blobs=0;
for(const r of results){
  removedBase64Blobs+=r.removedBase64Blobs;
  for(const repo of r.repos)repoSet.add(repo);
  for(const [token,repos] of r.tokens){
    if(!tokenToRepos.has(token))tokenToRepos.set(token,new Set());
    for(const repo of repos)tokenToRepos.get(token).add(repo);
  }
}
const sortedRepos=[...repoSet].sort();
const repoIndexMap=new Map();
sortedRepos.forEach((repo,i)=>repoIndexMap.set(repo,i));
const output={
  repos:sortedRepos,
  tokens:[...tokenToRepos.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([token,repos])=>[
    token,
    [...repos].map(r=>repoIndexMap.get(r)).sort((a,b)=>a-b)
  ])
};
writeFileSync("thinky.json",JSON.stringify(output));
const stats=statSync("thinky.json");
console.log("🧼 Removed base64 blobs: "+removedBase64Blobs);
console.log("🔡 Unique tokens found: "+tokenToRepos.size);
console.log("📦 Repositories indexed: "+sortedRepos.length);
console.log("💾 Saved thinky.json ("+Math.round(stats.size/1024)+" KB)");
}











async function getLatestUpdateTimestamp(){
try{
  const res=await octokit.repos.listForOrg({
    org:GITHUB_ORG,
    per_page:1,
    sort:"updated",
    direction:"desc"
  });
  return res.data[0]?.updated_at||null;
}catch(e){
  console.error("❌ Failed to fetch latest update timestamp:",e);
  return null;
}
}

function loadCachedTimestamp(){
try{
  return readFileSync(".repo-last-updated.txt","utf8").trim();
}catch{
  return null;
}
}

function saveCachedTimestamp(timestamp){
try{
  writeFileSync(".repo-last-updated.txt",timestamp);
}catch{}
}

async function main(){
let shouldFetch=true;
if(!SKIP_FETCH){
  const latest=await getLatestUpdateTimestamp();
  const cached=loadCachedTimestamp();
  if(latest&&latest===cached){
    console.log("✅ Repo list is up-to-date. Skipping fetch.");
    shouldFetch=false;
  }else{
    console.log("🔍 Fetching repository list from GitHub. This takes 2 minutes...");
  }

  if(shouldFetch){
    const rateBefore=await getRate();
    mkdirSync(ZIP_DIR,{recursive:true});
    mkdirSync(UNZIP_DIR,{recursive:true});
    const repos=await getAllRepos();
    saveCachedTimestamp(latest);
    const limiter=pLimit(MAX_PARALLEL);
    const downloadResults=await Promise.all(repos.map(r=>limiter(()=>downloadZip(r.name))));
    downloadResults.filter(Boolean).length;
    await Promise.all(repos.map(r=>limiter(()=>unzipRepo(r.name))));
    const rateAfter=await getRate();
    await printSummary(repos.length,rateBefore,rateAfter);
  }
}else{
  console.log("⏩ Skipping download");
}
await extractTokens();
}










process.on("SIGINT",async ()=>{
console.log("\n🛑 Interrupted with Ctrl+C");
await printSummary(0,null,null,true);
process.exit(130);
});
main().catch(err=>{
console.error("❌ Unhandled error:",err);
process.exit(1);
});
```
