#!/bin/bash

set -e  # stop script on first error

echo "Step 1: Install pnpm (pinned via corepack)"
corepack enable
corepack prepare --activate

echo "Step 2: Install dependencies"
pnpm install

echo "Step 3: Build api-server"
pnpm --filter @workspace/api-server run build

echo "Step 4: Build lexy"
pnpm --filter @workspace/lexy run build

echo "Step 5: Build lexy-site"
pnpm --filter @workspace/lexy-site run build

# echo "Step 6: Build lexy-demo"
# pnpm --filter @workspace/lexy-demo run build

# echo "Step 7: Run database migrations"
# pnpm --filter @workspace/db run push

echo "✅ All done!"