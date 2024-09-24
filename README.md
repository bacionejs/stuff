# Thinky
[Run](https://bacionejs.github.io/stuff/thinky.html)  
Thinky, a js13 code query tool  

ever wonder who uses speechsynth?  
https://bacionejs.github.io/stuff/thinky.html?word=speechSynthesis  

or who doesn't use a while/for loop?  
https://bacionejs.github.io/stuff/thinky.html?word=-while,-for  

audio?  
https://bacionejs.github.io/stuff/thinky.html?word=AudioContext  

find your buddies and other strange oddities at Thinky  
Brought to you by Stuff  

### Sorry
<span style="color: red;">If something is missing, see todo and limitation below</span>

### Todo
- [x] Unroll roadrollers which have signature: Function
- [ ] Unroll roadrollers which have signature: eval(r)
- [ ] Unroll roadrollers which have signature: document.write
- [ ] Include games which have special characters in their name

### Limitations
- **The data only contains words used by more than one game**. This is a **hack**, a way of ignoring...stuff, a cheap way to get what is significant, by consensus, versus using a real code analysis tool library which *understands* code.
- If you use zzfx and there are no word tokens which perfectly match at **least one other game**, then it is excluded, for example one game with token ZzFXM vs two games with token zzfxM.

## Developer Notes


After pasting the content of https://js13kgames.com/2024/games into page.txt, the scripts below perform some tasks:
- Gets games from github (only some, see todo)
- Unzips games  
- Unrolls roadroller (only some, see todo)
- Extracts data to be used by thinky.js (only some, see limitations)

### `git.sh`
```bash
mkdir games
cd games
cat page.txt | \
sed '1,4d' | head -n -20 | \
awk 'NR % 3 == 1' | \
while read folder
do curl -L -o $folder.zip https://github.com/js13kGames/games/raw/main/games/$folder/.src/g.zip
done

find . -mindepth 1 -maxdepth 1 -type d -exec sh -c 'cd "{}" && [ -f g.zip ] && unzip g.zip' \;
```

### `unroll.sh`
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








