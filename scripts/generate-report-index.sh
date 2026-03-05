#!/bin/bash
# Generate test report index page for GitHub Pages
# Usage: run from gh-pages directory: bash scripts/generate-report-index.sh
# Output: index.html in current directory

set -e

INDEX_HTML="index.html"

cat > "$INDEX_HTML" << 'INDEX_HEAD'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ChainSmith Test Reports Index</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 1.5rem; border-bottom: 1px solid #eee; padding-bottom: 0.5rem; }
    ul { list-style: none; padding-left: 0; }
    li { margin: 0.5rem 0; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .chain-name { font-weight: 600; }
  </style>
</head>
<body>
  <h1>ChainSmith Test Reports Index</h1>
  <p>Browse test reports by chain. Each chain shows the 10 most recent test runs.</p>
INDEX_HEAD

for chain_dir in */; do
  chain="${chain_dir%/}"
  [ -d "$chain" ] || continue
  echo "  <h2 class=\"chain-name\">${chain}</h2>" >> "$INDEX_HTML"
  echo "  <ul>" >> "$INDEX_HTML"
  for report_path in "${chain}"/*/; do
    [ -d "$report_path" ] || continue
    basename "$report_path"
  done 2>/dev/null | sort -nr 2>/dev/null | head -10 | while read -r run_id; do
    echo "    <li><a href=\"${chain}/${run_id}/\">Run #${run_id}</a></li>" >> "$INDEX_HTML"
  done
  echo "  </ul>" >> "$INDEX_HTML"
done

cat >> "$INDEX_HTML" << 'INDEX_TAIL'
</body>
</html>
INDEX_TAIL

echo "✅ Index page generated at ${INDEX_HTML}"
