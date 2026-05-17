#!/bin/bash
# Builds function.zip from lambdas/inbound/ for upload to AWS Lambda.
# Run from repo root: bash scripts/build-lambda.sh

set -e
cd lambdas/inbound
npm install --omit=dev
zip -r ../../function.zip . --exclude "*.test.js"
cd ../..
echo "Built function.zip ($(du -sh function.zip | cut -f1))"
