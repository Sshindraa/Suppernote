#!/usr/bin/env bash
set -euo pipefail

TARGET_URL="${SOKAR_DOGFOOD_URL:-https://suppernote.com}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT_DIR="${SOKAR_DOGFOOD_OUTPUT:-$REPO_ROOT/.hermes/dogfood}"
STAMP="$(date +%Y%m%d-%H%M%S)"
REPORT_DIR="$OUTPUT_DIR/$STAMP"
mkdir -p "$REPORT_DIR"

cat > "$REPORT_DIR/prompt.txt" <<PROMPT
Dogfood QA Suppernote production website/dashboard entrypoints.

Target: $TARGET_URL
Output directory: $REPORT_DIR

Scope:
- Public landing/pricing/navigation/contact flows.
- French-first copy consistency.
- Mobile/iPad layout risks.
- Console errors after navigation and interactions.
- Broken links, 404s, forms, CTAs.
- Visual regressions against Suppernote rules: static marketing preferred, logo/nav consistency, Shadcn token discipline where visible.

Workflow:
1. Use browser tools if available. Check console after every navigation and interaction.
2. Create screenshots for real issues only.
3. Save a concise markdown report to $REPORT_DIR/report.md.
4. Severity-order findings: Critical, High, Medium, Low.
5. End with: shipped/not shipped recommendation and top 3 fixes.

Do not modify production or submit real customer data. Use fake test data only.
PROMPT

hermes -z "$(cat "$REPORT_DIR/prompt.txt")"
