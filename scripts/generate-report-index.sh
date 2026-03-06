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
    .report-date { color: #656d76; font-size: 0.9em; margin-left: 0.5rem; }
  </style>
</head>
<body>
  <h1>ChainSmith Test Reports Index</h1>
  <p>Browse test reports by chain. Each chain shows the 10 most recent test runs.</p>
INDEX_HEAD

# Auto-discover chain report directories: only include dirs that have numeric subdirs (run_ids).
# This avoids maintaining a chain list - new chains added to the workflow are picked up automatically.
for chain_dir in */; do
  chain="${chain_dir%/}"
  [ -d "$chain" ] || continue
  # Skip if no numeric subdirs (run_ids from GitHub Actions)
  has_runs=false
  for report_path in "${chain}"/*/; do
    [ -d "$report_path" ] || continue
    run_id=$(basename "$report_path")
    if [[ "$run_id" =~ ^[0-9]+$ ]]; then
      has_runs=true
      break
    fi
  done
  $has_runs || continue
  echo "  <h2 class=\"chain-name\">${chain}</h2>" >> "$INDEX_HTML"
  echo "  <ul>" >> "$INDEX_HTML"
  for report_path in "${chain}"/*/; do
    [ -d "$report_path" ] || continue
    run_id=$(basename "$report_path")
    [[ "$run_id" =~ ^[0-9]+$ ]] || continue
    # Get deployment time: timestamp.txt (current run, written by workflow) or git log (past runs)
    if [ -f "${chain}/${run_id}/timestamp.txt" ]; then
      date_str=$(cat "${chain}/${run_id}/timestamp.txt" 2>/dev/null || echo "Unknown")
    else
      date_str=$(git log -1 --format=%cd --date=format:'%Y-%m-%d %H:%M' -- "${chain}/${run_id}" 2>/dev/null || echo "Unknown")
    fi
    echo "${run_id} ${date_str}"
  done 2>/dev/null | sort -t' ' -k1 -nr | head -10 | while read -r run_id date_str; do
    echo "    <li><a href=\"${chain}/${run_id}/\">Run #${run_id}</a><span class=\"report-date\">${date_str}</span></li>" >> "$INDEX_HTML"
  done
  echo "  </ul>" >> "$INDEX_HTML"
done

cat >> "$INDEX_HTML" << 'INDEX_TAIL'
</body>
</html>
INDEX_TAIL

echo "✅ Index page generated at ${INDEX_HTML}"
