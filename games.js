//===SetTitleDynamically===
document.title="js13k Games Viewer";

//===StyleInjection===
const style=document.createElement("style");
style.textContent=`
body{
font-family:sans-serif;
padding:1em;
line-height:1.4;
font-size:10px;
}
button,select{
margin-top:0.5em;
margin-right:0.5em;
}
#query-output{
white-space:pre-wrap;
margin-top:1em;
}
a{
text-decoration:none;
color:blue;
}
#topBtn{
position:fixed;
bottom:1em;
right:1em;
display:none;
z-index:999;
}
#filterBox{
margin-top:1em;
}`;
document.head.appendChild(style);

//===ElementCreator===
function el(tag,props={},children=[]){
const e=document.createElement(tag);
for(const [k,v] of Object.entries(props)){
  if(k==="on")for(const [ev,fn] of Object.entries(v))e.addEventListener(ev,fn);
  else if(k==="style")Object.assign(e.style,v);
  else e[k]=v;
}
children.forEach(c=>e.append(typeof c==="string"?document.createTextNode(c):c));
return e;
}

//===DataandMetadata===
const data=[];

function extractYear(game){
const matches=[...game.description.matchAll(/\b(20\d{2})\b/g)];
for(const m of matches)if(!game.name.includes(m[1]))return m[1];
if(matches.length)return matches[0][1];
return game.created_at.slice(0,4);
}

function extractAuthor(game){
if(game.parent && game.parent.includes("/"))
  return game.parent.split("/")[0];
const parts = game.description.split(/\bby\b/i);
if(parts.length > 1){
  const match = parts[parts.length - 1].match(/@?([^\s.,!?]+)/);
  if(match) return match[1];
}
return "unknown";
}

function minimum(game){
const play=game.homepage;
const github=game.html_url;
if(!play||!github)return null;
return{
year:extractYear(game),
play,
github,
title:game.name
};
}




//===QueryFunctions===
const queries={











groupByAuthor(){
const groups={};
data.forEach(game=>{
  const m=minimum(game); if(!m)return; const {year,play,github,title}=m;
  const author=extractAuthor(game);
  if(!groups[author])groups[author]=[];
  groups[author].push({year,play,github,title});
});
const frag=document.createDocumentFragment();
Object.entries(groups).sort((a,b)=>b[1].length-a[1].length).forEach(([author,games])=>{
  games.sort((a,b)=>Number(b.year)-Number(a.year));
  const div=el("div",{},[
    el("b",{},[author+" ("+games.length+" games)"]),
    el("br")
  ]);
  games.forEach(g=>{
    div.append(
      el("span",{},[
        "\u00A0\u00A0",
        el("a",{href:g.play,target:"_blank"},["play"]),
        " ",
        el("a",{href:g.github,target:"_blank"},["source"]),
        " "+g.year+" "+g.title
      ]),
      el("br")
    );
  });
  frag.append(div);
});
return frag;
},











groupByYear(){
const groups={};
data.forEach(game=>{
  const m=minimum(game); if(!m)return; const {year,play,github,title}=m;
  if(!groups[year])groups[year]=[];
  groups[year].push({play,github,full:title+" - "+game.description});
});
const frag=document.createDocumentFragment();
Object.entries(groups).sort((a,b)=>Number(b[0])-Number(a[0])).forEach(([year,games])=>{
  const div=el("div",{},[
    el("b",{},[year+" ("+games.length+" games)"]),
    el("br")
  ]);
  games.forEach(g=>{
    div.append(
      el("span",{},[
        "\u00A0\u00A0",
        el("a",{href:g.play,target:"_blank"},["play"]),
        " ",
        el("a",{href:g.github,target:"_blank"},["github"]),
        " "+g.full
      ]),
      el("br")
    );
  });
  frag.append(div);
});
return frag;
},











countByYear(){
const counts={};
let total=0;
data.forEach(game=>{
  const m=minimum(game); if(!m)return; const {year,play,github,title}=m;
  counts[year]=(counts[year]||0)+1;
  total++;
});
const lines=Object.entries(counts).sort((a,b)=>b[0]-a[0]).map(([y,c])=>y+": "+c);
return el("pre",{},[
  "\n",
  el("b",{},[total+" games in "+lines.length+" magical years \u{1F389}"]),
  "\n\n",
  lines.join("\n")
]);
}










};

//===DOMElements===
const output=el("div",{id:"query-output"});
const filterInput=el("input",{
id:"filterInput",
type:"text",
on:{input:applyFilter}
});
const filterBox=el("div",{id:"filterBox"},[
el("label",{htmlFor:"filterInput"},["Filter:"]),
filterInput
]);
const queryList=el("select",{
id:"queryList",
on:{change:loadAndRun}
},[
el("option",{value:"groupByAuthor"},["Group by author"]),
el("option",{value:"groupByYear"},["Group by year"]),
el("option",{value:"countByYear"},["Count by year"])
]);
const topBtn=el("button",{
id:"topBtn",
textContent:"Top",
on:{click:()=>scrollTo({top:0,behavior:"smooth"})}
});

//===MountEverything===
document.body.append(
el("h2",{},["JS13K Games Viewer"]),
el("label",{htmlFor:"queryList"},["Query:"]),
queryList,
filterBox,
output,
topBtn
);

//===Behavior===
function run(){
const key=queryList.value;
output.innerHTML="";
try{
  output.append(queries[key]());
  if(filterBox.style.display!=="none")applyFilter();
}catch(e){
  output.textContent="Error: "+e.message;
}
}

function loadAndRun(){
filterBox.style.display=queryList.value!=="groupByAuthor"?"none":"";
run();
}

function applyFilter(){
const query=filterInput.value.toLowerCase();
const blocks=output.querySelectorAll("div");
blocks.forEach(block=>{
  block.style.display=block.textContent.toLowerCase().includes(query)?"":"none";
});
}

addEventListener("scroll",()=>{
topBtn.style.display=scrollY>200?"block":"none";
});

//===LoadData===
fetch("games.json")
.then(res=>res.json())
.then(json=>{
  data.push(...json);
  loadAndRun();
});
