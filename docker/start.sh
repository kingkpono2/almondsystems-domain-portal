#!/usr/bin/env sh
set -eu
node /app/server/index.js &
exec apache2-foreground
