@echo off

echo Step 1: Install pnpn
call npm install -g pnpm

echo Step 2: Install dependencies
call pnpm install

echo Step 3: Build api-server
call pnpm --filter @workspace/api-server run build

echo Step 4: Build lexy
call pnpm --filter @workspace/lexy run build

echo Step 5: Build lexy-site
call pnpm --filter @workspace/lexy-site run build

@REM echo Step 6: Build lexy-demo
@REM call pnpm --filter @workspace/lexy-demo run build

@REM echo Step 7: Run database migrations
@REM call pnpm --filter @workspace/db run push

echo All done!
pause