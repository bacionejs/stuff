# Thinky
[Run](https://bacionejs.github.io/stuff/thinky.html)  
Thinky, a js13 code query tool  

ever wonder who uses speechsynth?  
https://bacionejs.github.io/stuff/thinky.html?word=speechSynthesis  

or who doesn't use a while/for loop?  
https://bacionejs.github.io/stuff/thinky.html?word=-while,-for  

audio?  
https://bacionejs.github.io/stuff/thinky.html?word=AudioContext  

zzfx?  
https://bacionejs.github.io/stuff/thinky.html?word=zzfx

find your buddies and other strange oddities at Thinky  
Brought to you by Stuff  



### Limitations
- **The data only contains words used by more than one game**
- Only html/js. No json, etc.

### Misc
Thinky is designed to compare 188 games and uses **consensus** to reduce 20,000 words to 5,000 words. If you want, I can change it.  

Here are some scripts to analyze your own code.  

**Sort all words by length**  

```cat minified.js|sed 's/base64[^=]*=//g'|tr -cs '[:alnum:]_' '\n'|awk '{print length,$0}'|sort -u|sort -n|cut -d' ' -f2```  


## Developer Notes
**THIS ARE NOT INSTRUCTIONS**  
I posted these notes so other people can
- see the specific logic used
- make suggestions for doing it **right**


**These scripts were run on Android Termux**  
- The ```unroll.js``` (un-roadroller) script is a homegrown hack. If you know the *right* way, like a tool, or better unroll logic, **please let me know**.  
- The ```extract.sh``` script extracts the data to be used by ```thinky.js```  

#### git.sh
Manually paste into ```page.txt```, the text of https://js13kgames.com/2024/games  
Make a folder called ```games```  
Run ```./git.sh```  
```bash
#!/bin/bash
#get game names
cat page.txt | sed '1,4d' | head -n -20 | awk 'NR % 3 == 1' | \
#fix game names
tr '[:upper:]' '[:lower:]' | \
sed "s/['.]//g" | \
sed 's/[^a-zA-Z0-9]/-/g' | sed 's/-\{2,\}/-/g' | sed 's/^-//;s/-$//' | \
#download submitted zips
while read folder; do
  mkdir games/$folder
  if curl -s -o /dev/null -w "%{http_code}" -L https://github.com/js13kGames/games/raw/main/games/$folder/.src/g.zip | grep "200"; then
    curl -L -o                     $folder.zip https://github.com/js13kGames/games/raw/main/games/$folder/.src/g.zip
    mv $folder.zip games/$folder/g.zip
  else
    echo "error: "$folder
  fi
done
#unzip
find games -name "*.zip" -exec sh -c 'unzip -q "{}" -d "$(dirname "{}")" || echo "$PWD/{}"' +
#delete zip
find games -name "*.zip" -exec rm -f {} +
#fix folder spaces
find games -name '* *' -exec bash -c 'mv -v "$0" "`echo $0 | tr " " "-"`"' {} +
```






#### unroll.js
Run ```node unroll.js games```  
```javascript
let fs = require('fs');
let path = require('path');
let vm = require('vm');

function extract(s) {
if      (new RegExp(/Function\s*\(\s*"\[M/gs).test(s)){
  let regex=/Function\s*\(\s*"\[M/gs;
  let match=regex.exec(s);
  let start=match.index;
  let p=1;
  let i=start+match[0].length;
  while(i<s.length && p>0){if(s[i]=='(')p++;if(s[i]==')')p--;i++;}
  while(i<s.length && s[i]!=='('){i++;}
  let args=1;
  i++;
  while(i<s.length && args>0){if(s[i]=='(')args++;if(s[i]==')')args--;i++;}
  s=s.substring(start,i);
  s=s.replace(/document.*"/,'return String.fromCharCode(...c)"');
  return s;
}else if(new RegExp(/<script>\s*M\s*=/g)     .test(s)){
  s=s.replace(new RegExp(/document.*</g),'String.fromCharCode(...n)<');
  s=s.replace(new RegExp(/eval\(r\)/g),  'eval(JSON.stringify(r))');
  return s.replace(/[\s\S]*<script\b[^>]*>([\s\S]*?)<\/script>[\s\S]*/,'$1');
}else{
  return undefined;
}
}

function main(file) {
fs.readFile(file, 'utf8', (err, data) => {
if (err) { console.error("Error reading file:", err); return; }
let script,unrolled,s;
try {
  s = extract(data);
  if (s) {
    script = new vm.Script(s);
    unrolled = script.runInContext(vm.createContext({}));
    overwrite(file,unrolled);
    console.log(`Successfully updated: ${file}`);
  }
} catch (error) {
  console.error("Error:", `${file} ${error.message}`);
}
});
}

function overwrite(file,unrolled){
fs.writeFile(file, unrolled, (writeErr) => {
  if (writeErr) {
    console.error("Error writing file:", writeErr);
  }
});
}

function processDirectory(dir) {
fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
if (err) { console.error("Error reading directory:", err); return; }
entries.forEach(entry => {
  let fullPath = path.join(dir, entry.name);
  if (entry.isDirectory()) { // Recursively process subdirectory
    processDirectory(fullPath);
  } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.html'))) {
    main(fullPath);
  }
});
});
}

let startDir = path.resolve(process.argv[2]);
processDirectory(startDir);
```






#### extract.sh
Run ```./extract.sh```
```bash
#!/bin/bash
# Canonicalize zzfx
find games -type f \( -name '*.html' -o -name '*.js' \) -exec sed -i -r 's/module:\[\[\[/zzfx/gi;s/zzfx\w*/zzfx/gi' {} +
# Find all .js and .html files
# Remove base64
# Split the remaining content into tokens based on non-alphanumeric except _
find games -type f \( -name "*.js" -o -name "*.html" \) -exec \
  awk --posix '{
      gsub(/base64[^=]+=/, "");
      n = split($0, tokens, /[^[:alnum:]_]/);
      for (i=1; i<=n; i++) if (tokens[i] != "") print FILENAME, tokens[i];
  }' {} + | \
# Extract the game name and token
awk -F'[/ ]' '{print $2, $NF}' | \
# Remove tokens starting with a digit
awk '$2 !~ /^[0-9]/' | \
# Remove tokens < 3 characters
awk 'length($2) > 2' | \
# Sort by token
sort -k2,2 | \
# Remove duplicates
uniq | \
# Remove tokens used by < 2 games
awk '{count[$2]++; games[$2] = (games[$2] ? games[$2] ORS : "") $1 " " $2} END {for (word in count) if (count[word] > 1) print games[word]}' | \
cat > data.txt
# Create foreignkeys for tokens
cat data.txt | awk '{if (!($2 in b)) { b[$2] = i++; } a[$1] = a[$1] ? a[$1] "," b[$2] : $1 "," b[$2]; } END { for (k in a) print a[k] }' > games.txt
# Create lookup table for tokens
cat data.txt | awk '{print $2}' | uniq | tr '\n' ',' | sed 's/,$//' > words.txt
```






