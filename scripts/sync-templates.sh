#!/usr/bin/env bash
set -euo pipefail

# Sync templates to providers (stub). Replace with provider SDK/CLI calls.

TEMPLATE_DIR="${TEMPLATE_DIR:-templates}"
PROVIDER=${PROVIDER:-resend}

if [ ! -d "$TEMPLATE_DIR" ]; then
  echo "Template directory '$TEMPLATE_DIR' not found." >&2
  exit 1
fi

echo "Syncing templates from $TEMPLATE_DIR to provider: $PROVIDER"
find "$TEMPLATE_DIR" -type f -name "*.html" -o -name "*.mjml" -o -name "*.txt"
echo "(stub) Implement provider-specific sync here."
