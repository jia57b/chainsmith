#!/bin/bash
# Merge multiple mochawesome JSON reports into a single HTML report
# Usage: ./scripts/merge-reports.sh
#
# Prerequisites: mochawesome-merge and mochawesome-report-generator
# are already in devDependencies

set -e

REPORT_DIR="tests/test-report"
MERGED_DIR="${REPORT_DIR}/merged"

echo "📊 Merging Mochawesome test reports..."
echo ""

# Check if report directory exists
if [ ! -d "$REPORT_DIR" ]; then
  echo "⚠️  No test report directory found at ${REPORT_DIR}"
  echo "   Creating empty report placeholder..."
  mkdir -p "$MERGED_DIR"
  cat > "${MERGED_DIR}/index.html" << 'PLACEHOLDER'
<!DOCTYPE html>
<html>
<head><title>ChainSmith Test Report</title></head>
<body>
  <h1>ChainSmith Test Report</h1>
  <p>No test results available. Tests may not have been executed.</p>
</body>
</html>
PLACEHOLDER
  exit 0
fi

# Find all mochawesome JSON files (exclude merged output)
JSON_FILES=$(find "$REPORT_DIR" -maxdepth 1 -name "*.json" -not -name "merged-report.json" | sort)
JSON_COUNT=$(echo "$JSON_FILES" | grep -c "." || echo "0")

if [ "$JSON_COUNT" -eq 0 ]; then
  echo "⚠️  No JSON report files found in ${REPORT_DIR}"
  mkdir -p "$MERGED_DIR"
  cat > "${MERGED_DIR}/index.html" << 'PLACEHOLDER'
<!DOCTYPE html>
<html>
<head><title>ChainSmith Test Report</title></head>
<body>
  <h1>ChainSmith Test Report</h1>
  <p>No test results available. Tests may not have produced report files.</p>
</body>
</html>
PLACEHOLDER
  exit 0
fi

echo "Found ${JSON_COUNT} report file(s):"
echo "$JSON_FILES" | while read -r f; do
  echo "  - $(basename "$f")"
done
echo ""

# Create merged output directory
mkdir -p "$MERGED_DIR"

# Step 1: Merge JSON reports
echo "Step 1/2: Merging JSON reports..."
npx mochawesome-merge "${REPORT_DIR}/*.json" -o "${REPORT_DIR}/merged-report.json"
echo "   ✅ Merged JSON created"
echo ""

# Step 2: Generate HTML report
echo "Step 2/2: Generating HTML report..."
npx marge "${REPORT_DIR}/merged-report.json" \
  --reportDir "$MERGED_DIR" \
  --reportFilename "index" \
  --reportTitle "ChainSmith CI Test Report" \
  --charts true \
  --showPassed true \
  --showFailed true \
  --showPending true \
  --showSkipped true \
  --showHooks "failed" \
  --inline true
echo "   ✅ HTML report generated"
echo ""

echo "============================================"
echo "  ✅ Report merge complete!"
echo "  📄 HTML: ${MERGED_DIR}/index.html"
echo "============================================"
