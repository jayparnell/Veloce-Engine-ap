#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run migrate:autopilot
pnpm --filter @workspace/api-server run build
