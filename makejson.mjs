#!/usr/bin/env node
import {Octokit} from"@octokit/rest";
import fs from"fs";
import path from"path";
import https from"https";
import {exec} from"child_process";

let GITHUB_TOKEN=process.env.GITHUB_TOKEN; let GITHUB_ORG="js13kGames"; let GAMES_REPO="games";
if(!GITHUB_TOKEN){console.error("Please set GITHUB_TOKEN in your environment.");process.exit(1);}
let octokit=new Octokit({auth:GITHUB_TOKEN});
let step=process.argv.find(arg=>arg.startsWith("--step="))?.split("=")[1];
if(!step){console.error("Usage: ./makejson.mjs --step=1|2|3");process.exit(1);}

async function step1(){
  console.log("Fetching metadata. May take an hour. Uses 1 api call token per repo. As of 2025, there were 2500 repos.");
  let {data}=await octokit.git.getTree({owner:GITHUB_ORG,repo:GAMES_REPO,tree_sha:"main",recursive:true});
  let forks=data.tree.filter(entry=>entry.type==="tree"&&/^games\/[^/]+$/.test(entry.path)).map(entry=>entry.path.replace(/^games\//,""));
  let results=[];
  for(let r of forks){
    try{
      let {data:d}=await octokit.repos.get({owner:GITHUB_ORG,repo:r}); if(!d.parent)continue;
      let p=d.parent;
      results.push({fork:d.full_name,owner:p.owner.login,name:p.name,branch:p.default_branch,stars:p.stargazers_count,date:p.created_at});
    }catch(err){console.warn("Error fetching '"+r+"': "+err.message);}
  }
  fs.writeFileSync("games.json",JSON.stringify(results,null,2));
}

async function step2(){
  console.log("Fetching zips. May take an hour.");
  printApiCalls();
  if(!fs.existsSync("games.json")){console.error("games.json not found. Run --step=1 first.");process.exit(1);}
  let repos=JSON.parse(fs.readFileSync("games.json"));
  for(let repo of repos){
    let zips="zips/"+repo.fork+".zip"; if(fs.existsSync(zips))continue;
    let url="https://github.com/"+repo.owner+"/"+repo.name+"/archive/refs/heads/"+repo.branch+".zip";
    await download(url,zips);
  }
  printApiCalls();
}

async function step3(){
  console.log("Creating tokens. May take a minute.");
  let u="unzips";
  await run("mkdir -p '"+u+"'");
  await run("bash -c 'for f in zips/*.zip; do unzip -o \"$f\" -d \""+u+"\"; done'");
  fs.readdirSync(u).forEach(f=>fs.renameSync(u+"/"+f,u+"/"+f.replace(/-(master|main|gh-pages)$/,"")));
  await run("find '"+u+"' -type l -exec rm {} +");
  await run("find '"+u+"' -type d -name 'node_modules' -exec rm -rf {} +");
  await run("find '"+u+"' -type f ! -iname '*.js' ! -iname '*.ts' ! -iname '*.html' ! -iname '*.htm' -delete");
  let t="tokens.json";
  let tokenToRepos=new Map();
  let all=new Set();
  for(let f of files(u)){
    try{
      if(fs.statSync(f).size>500*1024)continue; let repo=extractRepoName(f);if(!repo)continue;
      all.add(repo);
      let text=fs.readFileSync(f,"utf8");
      text=text.replace(/base64,[A-Za-z0-9+/=]+/g," "); text=text.replace(/['\"`][A-Za-z0-9+/=]{40,}['\"`]/g," "); text=text.replace(/['\"`][A-Za-z0-9_@#%$*^!<>?:;.,|~`-]{40,}['\"`]/g," ");
      let tokens=text.match(/\b[a-zA-Z0-9_]+\b/g);if(!tokens)continue;
      let unique=new Set();
      for(let tok of tokens){
        if(tok.length<3||tok.length>50)continue; if(/^[0-9_]/.test(tok))continue; if(tok===tok.toUpperCase())continue;
        unique.add(tok);
      }
      for(let tok of unique){ if(!tokenToRepos.has(tok))tokenToRepos.set(tok,new Set()); tokenToRepos.get(tok).add(repo); }
    }catch(e){console.error("Failed processing file "+f+": "+e.message);}
  }
  let sortedRepos=[...all].sort();
  let repoIndexMap=new Map(sortedRepos.map((repo,i)=>[repo,i]));
  let tokenEntries=[...tokenToRepos.entries()]
    .filter(([,repos])=>repos.size>=2)
    .sort(([a],[b])=>a.localeCompare(b))
    .map(([token,repos])=>[token,[...repos].map(repo=>repoIndexMap.get(repo)).sort((a,b)=>a-b)]);
  let output={repos:sortedRepos,tokens:tokenEntries};
  fs.writeFileSync(t,JSON.stringify(output));
}

function printApiCalls(){console.log("API calls remaining:",octokit.request.endpoint.defaults.headers['x-ratelimit-remaining']||"unknown");}
function download(url,dest){return new Promise((resolve,reject)=>{https.get(url,res=>{if(res.statusCode!==200)return reject(res.statusCode);fs.mkdirSync(path.dirname(dest),{recursive:true});let f=fs.createWriteStream(dest);res.pipe(f);f.on("finish",()=>f.close(resolve));}).on("error",reject);});}
function run(cmd){return new Promise((resolve,reject)=>{exec(cmd,{maxBuffer:1024*1024*50},(err,stdout,_)=>{if(err)return reject(err);resolve(stdout);});});}
function files(dir){let r=[];for(let f of fs.readdirSync(dir,{withFileTypes:true})){let full=path.join(dir,f.name);if(f.isDirectory())r.push(...files(full));else r.push(full);}return r;}
function extractRepoName(filePath){let u="unzips";let parts=filePath.split(path.sep);let idx=parts.indexOf(u);if(idx===-1||idx+1>=parts.length)return null;return parts[idx+1];}

(async()=>{if(step==="1")await step1();else if(step==="2")await step2();else if(step==="3")await step3();else console.error("Invalid step. Use --step=1|2|3");})();
