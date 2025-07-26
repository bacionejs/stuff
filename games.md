
> ⚠️ **Warning:** These are dev notes, not usage instructions.

A script generates a JSON snapshot, periodically, enabling a dynamic interface without relying on a live backend.

### Extracts:

Name: `name`

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





> In the context of js13kGames, if a competitor deletes their GitHub account after submitting, their username may become available for someone else to claim, which can cause old game links to point to unrelated or misleading content. Furthermore, GitHub @mentions are not a reliable long-term reference, since users may delete their accounts, making the mention unresolvable in the future.





```js
import {Octokit}from "@octokit/rest";
import fs from "fs";
import pLimit from "p-limit";

const octokit=new Octokit({auth:process.env.GITHUB_TOKEN});
const OUTPUT_FILE="games.json";
const LAST_UPDATED_FILE=".repo-last-updated.txt";
const LIMIT=0;
const MAX_PARALLEL=10;

const EXCLUDED=new Set([
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
"glitchd",
"Triska",
"The-Maze",
"Anti_Virus",
"__OFF_THE_LINE__",
"Out_Of_Memory",
"snakee",
"A.W.E.S.O.M.E"
]);

let repoData=[];
let shuttingDown=false;

process.on("SIGINT",()=>{
if(!shuttingDown){
  shuttingDown=true;
  console.log("\n🛑 CTRL-C detected. Writing partial output to "+OUTPUT_FILE);
  writeLog();
  process.exit();
}
});

function writeLog(){
fs.writeFileSync(OUTPUT_FILE,JSON.stringify(repoData,null,2),"utf8");
}

function loadCachedTimestamp(){
try{
  return fs.readFileSync(LAST_UPDATED_FILE,"utf8").trim();
}catch{
  return null;
}
}

function saveCachedTimestamp(timestamp){
try{
  fs.writeFileSync(LAST_UPDATED_FILE,timestamp);
}catch{}
}

async function getLatestUpdateTimestamp(){
try{
  const res=await octokit.repos.listForOrg({
    org:"js13kGames",
    per_page:1,
    sort:"updated",
    direction:"desc"
  });
  return res.data[0]?res.data[0].updated_at:null;
}catch(e){
  console.error("❌ Failed to fetch latest update timestamp: "+e.message);
  return null;
}
}

async function getRepos(){
const options={
  org:"js13kGames",
  type:"public",
  per_page:LIMIT>0?LIMIT:100
};
const all=LIMIT>0
  ?(await octokit.repos.listForOrg(options)).data.slice(0,LIMIT)
  :await octokit.paginate(octokit.repos.listForOrg,options);
return all.filter(repo=>!EXCLUDED.has(repo.name));
}

function extractAuthors(description){
if(!description)return null;
const match=description.match(/\bby\b/i);
if(!match)return null;
const afterBy=description.split(/\bby\b/i)[1].split(".")[0].trim();
const mentions=Array.from(afterBy.matchAll(/@([a-z0-9_-]+)/gi)).map(function(m){
  return m[1];
});
if(mentions.length>0)return mentions;
const fallback=afterBy.split(/[,&]/)[0].trim().split(/\s+/);
return fallback.length===1&&fallback[0]?[fallback[0]]:null;
}

function extractYear(description,created_at){
const match=description&&description.match(/a js13kGames\s+(\d{4})/i);
return match?parseInt(match[1]):parseInt(created_at.slice(0,4));
}

async function processRepo(i,repo){
try{
  const full=(await octokit.repos.get({
    owner:repo.owner.login,
    repo:repo.name
  })).data;

//  const entry={name:full.name};
//  entry.stars=full.stargazers_count;





const entry={
  name:full.name,
  stars:full.parent?.stargazers_count || full.stargazers_count
};




  let authors=["unknown"];
  const descAuthors=extractAuthors(full.description);
  if(descAuthors){
    authors=descAuthors;
  }else if(full.parent&&full.parent.full_name&&full.parent.full_name.indexOf("/")!==-1){
    authors=[full.parent.full_name.split("/")[0]];
  }else{
    const contributors=(await octokit.repos.listContributors({
      owner:repo.owner.login,
      repo:repo.name,
      per_page:1
    })).data;
    if(contributors.length>0){
      authors=[contributors[0].login];
    }
  }

  entry.authors=authors;
  entry.year=extractYear(full.description,full.created_at);
  repoData.push(entry);

  console.log("✅ "+(i+1)+": "+repo.name+" by "+authors.join(", "));
}catch(err){
  console.warn("⚠️ Error on "+repo.name+": "+err.message);
}
}

async function buildLog(){
const latest=await getLatestUpdateTimestamp();
const cached=loadCachedTimestamp();
if(latest&&cached===latest){
  console.log("✅ Repo list is up-to-date. Skipping fetch.");
  return;
}

console.log("📡 Fetching repo list. This takes two minutes...");

const rate=await octokit.rateLimit.get();
console.log("⏱️ GitHub Rate Limit: "+rate.data.rate.used+"/"+rate.data.rate.limit);
console.log("⏳ Resets at: "+new Date(rate.data.rate.reset*1000).toLocaleString());

const repos=await getRepos();
console.log("📦 Total repos fetched (after exclusions): "+repos.length);

const limit=pLimit(MAX_PARALLEL);
const tasks=repos.map(function(repo,i){
  return limit(function(){
    return processRepo(i,repo);
  });
});
await Promise.all(tasks);

writeLog();
saveCachedTimestamp(latest);
console.log("✅ Done. Output saved to "+OUTPUT_FILE);
}

buildLog().catch(function(err){
console.error("🔥 Unhandled error: "+err.message);
writeLog();
});
```
