#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { resolveContext } from '../lib/config/context';
import { NetworkStack } from '../lib/stacks/network-stack';
import { BackendStack } from '../lib/stacks/backend-stack';
import { FrontendStack } from '../lib/stacks/frontend-stack';

const app = new cdk.App();

// Account and region are resolved from environment variables set by the CDK CLI
// after running `cdk bootstrap`. They are NEVER hardcoded here.
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// Resolve and validate all context parameters once at synth time.
// Fails fast with a clear error before any CloudFormation is generated.
const ctx = resolveContext(app.node, env);

const stackPrefix = `${ctx.appName}-${ctx.environment}`;

const networkStack = new NetworkStack(app, `${stackPrefix}-network`, {
  env,
  ctx,
  description: 'VPC, subnets, security groups, and ALB log bucket',
  terminationProtection: ctx.removalPolicy === 'RETAIN',
});

const backendStack = new BackendStack(app, `${stackPrefix}-backend`, {
  env,
  ctx,
  vpc: networkStack.vpc,
  blueAlbSecurityGroup: networkStack.blueAlbSecurityGroup,
  greenAlbSecurityGroup: networkStack.greenAlbSecurityGroup,
  ecsSecurityGroup: networkStack.ecsSecurityGroup,
  albLogBucket: networkStack.albLogBucket,
  description: 'ECS Fargate blue/green services, ALB, and CloudWatch observability',
  terminationProtection: ctx.removalPolicy === 'RETAIN',
});

// BackendStack depends on NetworkStack — make the dependency explicit so CDK
// deploys them in the correct order and surfaces cross-stack errors clearly.
backendStack.addDependency(networkStack);

const frontendStack = new FrontendStack(app, `${stackPrefix}-frontend`, {
  env,
  ctx,
  description: 'S3 static assets bucket and CloudFront distribution',
  terminationProtection: ctx.removalPolicy === 'RETAIN',
});

// FrontendStack is independent of the other two stacks — no addDependency needed.
// It can be deployed or torn down in isolation.
void frontendStack;

cdk.Tags.of(app).add('AppName', ctx.appName);
cdk.Tags.of(app).add('Environment', ctx.environment);
cdk.Tags.of(app).add('ManagedBy', 'CDK');
