

Paste content of https://js13kgames.com/2024/games into page.txt
Get games from github
Unzip games
### `git.sh`
```bash
mkdir games
cd games
cat page.txt | \
sed '1,4d' filename | head -n -20 | \
awk 'NR % 3 == 1' | \
while read folder
do curl -L -o $folder.zip https://github.com/js13kGames/games/raw/main/games/$folder/.src/g.zip
done

find . -mindepth 1 -maxdepth 1 -type d -exec sh -c 'cd "{}" && [ -f g.zip ] && unzip g.zip' \;
```

Unroll roadroller
```bash
find games -type f \( -name "*.js" -o -name "*.html" \) -exec grep -Plz 'Function\s*\(\s*"\[M' {} \; -exec sh -c 'node unroll.js "$1" > "$1.tmp" && mv "$1.tmp" "$1"' _ {} \;
```

### `unroll.js`

```js
let fs=require('fs');
let path=require('path');
let vm=require('vm');

function extract(s){
let regex=/Function\s*\(\s*"\[M/gs;
let match=regex.exec(s);
let start=match.index;
let p=1;
let i=start+match[0].length;
while(i<s.length&&p>0){if(s[i]=='(')p++;if(s[i]==')')p--;i++;}
while(i<s.length&&s[i]!=='('){i++;}
let args=1;
i++;
while(i<s.length&&args>0){if(s[i]=='(')args++;if(s[i]==')')args--;i++;}
return s.substring(start,i);
}

function main(file){
fs.readFile(file,'utf8',(err,data)=>{
  try{
    let script=new vm.Script(`(eval(${JSON.stringify(extract(data))}))`);
    let unrolled=script.runInContext(vm.createContext({}));
    console.log(unrolled);
  }catch(error){console.error("Error:",error.message);}
});
}

main(path.resolve(process.argv[2]));
```


Extract data
### `extract.sh`
```bash
#!/bin/bash
# Find all .js and .html files
# Remove content inside quotes
# Split the remaining content into tokens based on non-alphanumeric except _
find games -type f \( -name "*.js" -o -name "*.html" \) -exec \
awk "{
    gsub(/\"[^\"]*\"/, \"\"); 
    gsub(/\'[^\']*\'/, \"\");
    n = split(\$0, tokens, /[^[:alnum:]_]/);
    for (i=1; i<=n; i++) if (tokens[i] != \"\") print FILENAME, tokens[i];
}" {} + | \

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








# stuff

get mobile/desktop games  
remove games with special characters in the name  
get contents of js/html  
remove quoted parts  
split by /[^[:alnum:]_]/  
get tokens !/^[0-9]/ && length 3-19  
get tokens used by > 1 game  
get tokens where at least the first 3 characters are a dictionary word (but keep making the word longer until a hit or end of token)  
...reduced 178704 records to 2245  

```bash
find games -type f \( -name "*.js" -o -name "*.html" \) -exec \
awk "{
    gsub(/\"[^\"]*\"/, \"\"); 
    gsub(/\'[^\']*\'/, \"\");
    n = split(\$0, tokens, /[^[:alnum:]_]/);
    for (i=1; i<=n; i++) if (tokens[i] != \"\") print FILENAME, tokens[i];
}" {} + | \

awk -F'[/ ]' '{print $2, $NF}' | \

awk '$2 !~ /^[0-9]/ && length($2) > 2' | \

sort | \

uniq | \

awk '{count[$2]++} END {for (word in count) print count[word], word}' | \

awk '$1 > 1' | \

sort -k1,1nr | \

while read w1 w2; do
  for ((i=3; i<=${#w2}; i++)); do
    if ! [[ $(echo "${w2:0:i}" | tr '[:upper:]' '[:lower:]' | aspell list) ]]; then
      echo "$w1 $w2"
      break
    fi
  done
done
```