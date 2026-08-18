#!/usr/bin/env bash
# Deploys the agentguard-pod-worker Lambda function used by the "AWS Lambda chaos" demo:
# the backend invokes this real function, and a genuine crash/OOM/timeout becomes an incident.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
FUNC_NAME="agentguard-pod-worker"
ROLE_NAME="agentguard-pod-worker-role"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "Creating IAM role $ROLE_NAME..."
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    >/dev/null
  aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "Waiting for IAM role to propagate..."
  sleep 10
fi

cd "$DIR/pod-worker"
rm -f function.zip
powershell.exe -NoProfile -Command "Compress-Archive -Path handler.js -DestinationPath function.zip -Force"

if aws lambda get-function --function-name "$FUNC_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "Updating existing function $FUNC_NAME..."
  aws lambda update-function-code \
    --function-name "$FUNC_NAME" \
    --zip-file fileb://function.zip \
    --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$FUNC_NAME" --region "$REGION"
  # Reset memory/timeout/env vars to baseline each deploy — undoes whatever the remediation
  # agent's real UpdateFunctionConfiguration calls left in place, so the chaos demo is repeatable.
  aws lambda update-function-configuration \
    --function-name "$FUNC_NAME" \
    --memory-size 128 \
    --timeout 5 \
    --environment "Variables={}" \
    --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$FUNC_NAME" --region "$REGION"
else
  echo "Creating function $FUNC_NAME..."
  aws lambda create-function \
    --function-name "$FUNC_NAME" \
    --runtime nodejs20.x \
    --role "$ROLE_ARN" \
    --handler handler.handler \
    --zip-file fileb://function.zip \
    --memory-size 128 \
    --timeout 5 \
    --region "$REGION" >/dev/null
fi

echo "Deployed: $FUNC_NAME in $REGION (role: $ROLE_ARN)"
