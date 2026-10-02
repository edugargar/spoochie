#!/bin/sh
# Closing the session closes your live spoochies.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/bin/spoochie" unregister 2>/dev/null || true
