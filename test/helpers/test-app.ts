import * as cdk from 'aws-cdk-lib';

/**
 * Default context values used across all unit tests.
 * Tests that need to override a specific value should spread this object and
 * call app.node.setContext() for the keys they need to change.
 *
 * IMPORTANT: unit tests must NOT make AWS API calls (no VPC lookups, no resource
 * imports that require account/region). All constructs in this project accept
 * concrete objects (not lookups) so tests stay offline.
 */
export const DEFAULT_CONTEXT: Record<string, unknown> = {
  appName: 'test-app',
  environment: 'test',
  vpcMaxAzs: 2,
  vpcNatGateways: 1,
  ecsBlueContainerImage: 'public.ecr.aws/docker/library/nginx:1.27-alpine',
  ecsGreenContainerImage: 'public.ecr.aws/docker/library/nginx:1.27-alpine',
  ecsImageSource: 'asset',
  ecsContainerPort: 80,
  ecsCpu: 512,
  ecsMemoryMiB: 1024,
  ecsBlueDesiredCount: 2,
  ecsGreenDesiredCount: 0,
  blueTrafficWeight: 100,
  greenTrafficWeight: 0,
  logRetentionDays: 30,
  albLogRetentionDays: 90,
  alarm5xxRateThresholdPercent: 5,
  healthCheckPath: '/',
  removalPolicy: 'DESTROY',
  cloudFrontPriceClass: 'PriceClass_100',
};

export const TEST_ENV: cdk.Environment = {
  account: '123456789012',
  region: 'us-east-1',
};

/**
 * Creates a CDK App with all required context pre-loaded.
 * Pass overrides to replace specific context values for a test.
 */
export function createTestApp(overrides: Record<string, unknown> = {}): cdk.App {
  const app = new cdk.App({ context: { ...DEFAULT_CONTEXT, ...overrides } });
  return app;
}
