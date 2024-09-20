# stuff

get mobile/desktop games
remove games with special characters in the name
get contents of js/html
remove quoted parts
split by /[^[:alnum:]_]/
get tokens !/^[0-9]/ && length 3-19
get tokens used by > 1 game
get tokens where at least the first 3 characters are a dictionary word
...reduced 178704 records to 2245

bash ```
find games -type f \( -name "*.js" -o -name "*.html" \) -exec \
awk "{
    # Remove content inside single and double quotes
    gsub(/\"[^\"]*\"/, \"\"); 
    gsub(/\'[^\']*\'/, \"\");
    # Split the remaining content into tokens based on non-alphanumeric except _
    n = split(\$0, tokens, /[^[:alnum:]_]/);
    for (i=1; i<=n; i++) if (tokens[i] != \"\") print FILENAME, tokens[i];
}" {} + | \

awk -F'[/ ]' '{print $2, $NF}' | \

awk '$2 !~ /^[0-9]/ && length($2) > 2 && length($2) < 20' | \

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
