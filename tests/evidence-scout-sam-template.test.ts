import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const templatePath = path.join(process.cwd(), "infra/evidence-scout-lambda/template.yaml");
const template = readFileSync(templatePath, "utf8");

test("SAM template declares an explicit Lambda runtime role with no managed policies", () => {
  assert.match(template, /^  EvidenceScoutSearchFunctionRole:\n    Type: AWS::IAM::Role$/m);
  assert.match(template, /RoleName: !Sub "\$\{AWS::StackName\}-lambda-runtime"/);
  assert.match(template, /Service:\n\s+- lambda\.amazonaws\.com/);
  assert.match(template, /Action:\n\s+- sts:AssumeRole/);
  assert.doesNotMatch(template, /ManagedPolicyArns:/);
  assert.doesNotMatch(template, /AWSLambdaBasicExecutionRole/);
  assert.doesNotMatch(template, /AWSLambdaSQSQueueExecutionRole/);
});

test("SAM template limits runtime SQS and secrets access to exact resources", () => {
  assert.match(template, /sqs:ReceiveMessage/);
  assert.match(template, /sqs:DeleteMessage/);
  assert.match(template, /sqs:GetQueueAttributes/);
  assert.match(template, /sqs:ChangeMessageVisibility/);
  assert.match(template, /Resource: !GetAtt EvidenceScoutQueue\.Arn/);

  const secretsBlock = /PolicyName: lambda-runtime-secrets[\s\S]*?Resource:\n\s+- !Ref DatabaseUrlSecretArn\n\s+- !Ref OpenAiApiKeySecretArn/;
  assert.match(template, secretsBlock);
});

test("SAM template keeps logs scoped to the Lambda log group and grants no S3 access", () => {
  assert.match(
    template,
    /logs:CreateLogStream[\s\S]*logs:PutLogEvents[\s\S]*Resource: !Sub "arn:\$\{AWS::Partition\}:logs:\$\{AWS::Region\}:\$\{AWS::AccountId\}:log-group:\/aws\/lambda\/evidence-scout-search:log-stream:\*"/,
  );
  assert.doesNotMatch(template, /Resource:\s*["']?\*["']?/);
  assert.doesNotMatch(template, /\bs3:/);
});

test("SAM function uses the explicit runtime role and does not declare SAM-generated policies", () => {
  const functionBlockMatch = template.match(/  EvidenceScoutSearchFunction:\n[\s\S]*?(?=\n  [A-Z]|\nOutputs:)/);
  assert.ok(functionBlockMatch, "EvidenceScoutSearchFunction block missing");
  const functionBlock = functionBlockMatch[0];

  assert.match(functionBlock, /DependsOn:\n\s+- EvidenceScoutSearchFunctionLogGroup/);
  assert.match(functionBlock, /Role: !GetAtt EvidenceScoutSearchFunctionRole\.Arn/);
  assert.doesNotMatch(functionBlock, /\n\s+Policies:/);
  assert.doesNotMatch(functionBlock, /ReservedConcurrentExecutions:/);
  assert.match(
    functionBlock,
    /SearchQueue:\n\s+Type: SQS\n\s+Properties:\n\s+Enabled: true\n\s+Queue: !GetAtt EvidenceScoutQueue\.Arn\n\s+BatchSize: 1[\s\S]*?ScalingConfig:\n\s+MaximumConcurrency: 3\n\s+FunctionResponseTypes:\n\s+- ReportBatchItemFailures/,
  );
  assert.match(
    functionBlock,
    /BuildProperties:\n\s+EntryPoints:\n\s+- lib\/server\/evidence-scout-lambda-bootstrap\.ts\n\s+Format: cjs\n\s+Minify: false\n\s+OutExtension:\n\s+- \.js=\.js\n\s+Sourcemap: true\n\s+Target: es2022/,
  );
});

test("SAM template exports the explicit runtime role ARN", () => {
  assert.match(template, /LambdaRuntimeRoleArn:\n\s+Value: !GetAtt EvidenceScoutSearchFunctionRole\.Arn/);
});
