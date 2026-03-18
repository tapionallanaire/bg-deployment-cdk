import * as cdk from 'aws-cdk-lib';
import { Node } from 'constructs';

/**
 * All CDK context parameters used across stacks.
 * Read once via resolveContext() at app startup; passed down as a typed object.
 * Set values in cdk.json or via --context flags at deploy time.
 */
export interface AppContext {
  /** Short prefix used in all resource names. No spaces or special chars. */
  readonly appName: string;
  /** Deployment environment label (dev | staging | prod). */
  readonly environment: string;
  /** AWS account ID. Resolved from context; never hardcoded. */
  readonly account: string;
  /** AWS region. Resolved from context; never hardcoded. */
  readonly region: string;

  // ── Networking ──────────────────────────────────────────────────────────────
  /** Number of Availability Zones for the VPC. Default: 2. */
  readonly vpcMaxAzs: number;
  /** Number of NAT gateways. Use 1 for dev (cost), 2 for prod (HA). Default: 1. */
  readonly vpcNatGateways: number;

  // ── Backend ─────────────────────────────────────────────────────────────────
  /** Docker image for the blue service (ECR URI or public image). */
  readonly ecsBlueContainerImage: string;
  /** Docker image for the green service (ECR URI or public image). */
  readonly ecsGreenContainerImage: string;
  /** Container TCP port exposed by the application. Default: 80. */
  readonly ecsContainerPort: number;
  /** Fargate task CPU units. Default: 512 (0.5 vCPU). */
  readonly ecsCpu: number;
  /** Fargate task memory in MiB. Default: 1024. */
  readonly ecsMemoryMiB: number;
  /** Desired task count for the blue service. Default: 1. */
  readonly ecsBlueDesiredCount: number;
  /**
   * Desired task count for the green service.
   * Set to 0 at rest so no idle capacity is paid for outside a deployment.
   * The shift script scales this up before moving traffic.
   * Default: 0.
   */
  readonly ecsGreenDesiredCount: number;
  /** Weight assigned to the blue Route 53 alias record (0–100). Must sum to 100 with greenTrafficWeight. */
  readonly blueTrafficWeight: number;
  /** Weight assigned to the green Route 53 alias record (0–100). Must sum to 100 with blueTrafficWeight. */
  readonly greenTrafficWeight: number;
  /** CloudWatch log group retention in days for ECS tasks. Default: 30. */
  readonly logRetentionDays: number;
  /** S3 lifecycle expiration for ALB access logs in days. Default: 90. */
  readonly albLogRetentionDays: number;
  /** ALB 5xx error rate percentage threshold before the CloudWatch alarm fires. Default: 5. */
  readonly alarm5xxRateThresholdPercent: number;
  /** ALB health check path. Default: '/'. */
  readonly healthCheckPath: string;
  /**
   * ACM certificate ARN for the blue/green ALB HTTPS listeners.
   * If omitted, the ALB listener runs on HTTP (port 80) only — acceptable for dev.
   */
  readonly certificateArn?: string;
  /**
   * Route 53 hosted zone ID for creating weighted alias records that point to the
   * blue and green ALBs. If omitted, no Route 53 records are created and you access
   * the services via the direct ALB DNS names.
   */
  readonly hostedZoneId?: string;
  /** Route 53 hosted zone name (e.g. 'example.com'). Required if hostedZoneId is set. */
  readonly hostedZoneName?: string;
  /** Weighted backend DNS name (e.g. 'api.example.com'). Required if hostedZoneId is set. */
  readonly albDomainName?: string;

  // ── Frontend ────────────────────────────────────────────────────────────────
  /**
   * CloudFront price class. Controls which edge locations are used.
   * PriceClass_100 (US/EU only — cheapest), PriceClass_200, PriceClass_All.
   * Default: 'PriceClass_100'.
   */
  readonly cloudFrontPriceClass: string;
  /** Custom domain for the CloudFront distribution (e.g. 'www.example.com'). Optional. */
  readonly customDomainName?: string;
  /**
   * ACM certificate ARN for CloudFront. MUST be in us-east-1.
   * Required when customDomainName is set.
   */
  readonly frontendCertificateArn?: string;
  /** Route 53 hosted zone ID for the CloudFront alias record. Required when customDomainName is set. */
  readonly frontendHostedZoneId?: string;
  /** Route 53 hosted zone name for the CloudFront alias record. Required when customDomainName is set. */
  readonly frontendHostedZoneName?: string;

  // ── Shared ──────────────────────────────────────────────────────────────────
  /**
   * Removal policy for all stateful resources (S3 buckets, log groups).
   * 'DESTROY' — resources and all data deleted on stack removal (safe for dev).
   * 'RETAIN' — resources survive stack removal (required for prod, avoids accidental data loss).
   * Default: 'DESTROY'.
   */
  readonly removalPolicy: 'DESTROY' | 'RETAIN';
}

function requireContext(node: Node, key: string): string {
  const value: unknown = node.tryGetContext(key);
  if (value === undefined || value === null || value === '') {
    throw new Error(
      `Missing required CDK context key: "${key}". ` +
        `Set it in cdk.json or pass --context ${key}=<value> at deploy time.`,
    );
  }
  return String(value);
}

function optionalContext(node: Node, key: string): string | undefined {
  const value: unknown = node.tryGetContext(key);
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return String(value);
}

function numberContext(node: Node, key: string, defaultValue: number): number {
  const value: unknown = node.tryGetContext(key);
  if (value === undefined || value === null) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (isNaN(parsed)) {
    throw new Error(`CDK context key "${key}" must be a number, got: "${String(value)}"`);
  }
  return parsed;
}

/**
 * Resolves and validates all CDK context parameters into a typed AppContext object.
 * Call once at app startup (bin/app.ts) — pass the result to every stack.
 *
 * Fails fast at synth time with a clear error message if a required key is missing,
 * rather than surfacing runtime CloudFormation errors during deploy.
 */
export function resolveContext(node: Node, env: cdk.Environment): AppContext {
  const appName = requireContext(node, 'appName');
  const environment = requireContext(node, 'environment');
  const blueTrafficWeight = numberContext(node, 'blueTrafficWeight', 100);
  const greenTrafficWeight = numberContext(node, 'greenTrafficWeight', 0);
  const defaultContainerImage = optionalContext(node, 'ecsContainerImage');
  const ecsBlueContainerImage =
    optionalContext(node, 'ecsBlueContainerImage') ?? defaultContainerImage;

  if (!ecsBlueContainerImage) {
    throw new Error(
      'ecsBlueContainerImage is required. ' +
        'Set it directly or provide the legacy ecsContainerImage context key.',
    );
  }

  const ecsGreenContainerImage =
    optionalContext(node, 'ecsGreenContainerImage') ?? ecsBlueContainerImage;

  if (blueTrafficWeight + greenTrafficWeight !== 100) {
    throw new Error(
      `blueTrafficWeight (${blueTrafficWeight}) + greenTrafficWeight (${greenTrafficWeight}) must equal 100.`,
    );
  }

  const removalPolicyRaw = optionalContext(node, 'removalPolicy') ?? 'DESTROY';
  if (removalPolicyRaw !== 'DESTROY' && removalPolicyRaw !== 'RETAIN') {
    throw new Error(`removalPolicy must be 'DESTROY' or 'RETAIN', got: "${removalPolicyRaw}"`);
  }

  const alarm5xxRateThresholdPercent = numberContext(
    node,
    'alarm5xxRateThresholdPercent',
    numberContext(node, 'alarm5xxThreshold', 5),
  );

  if (alarm5xxRateThresholdPercent <= 0 || alarm5xxRateThresholdPercent > 100) {
    throw new Error(
      `alarm5xxRateThresholdPercent must be between 0 and 100, got: ${alarm5xxRateThresholdPercent}`,
    );
  }

  const hostedZoneId = optionalContext(node, 'hostedZoneId');
  const hostedZoneName = optionalContext(node, 'hostedZoneName');
  const albDomainName = optionalContext(node, 'albDomainName');

  if (hostedZoneId && (!hostedZoneName || !albDomainName)) {
    throw new Error(
      'hostedZoneName and albDomainName are required when hostedZoneId is set.',
    );
  }

  const customDomainName = optionalContext(node, 'customDomainName');
  const frontendCertificateArn = optionalContext(node, 'frontendCertificateArn');

  if (customDomainName && !frontendCertificateArn) {
    throw new Error(
      'frontendCertificateArn (us-east-1) is required when customDomainName is set.',
    );
  }

  return {
    appName,
    environment,
    account: env.account!,
    region: env.region!,
    vpcMaxAzs: numberContext(node, 'vpcMaxAzs', 2),
    vpcNatGateways: numberContext(node, 'vpcNatGateways', 1),
    ecsBlueContainerImage,
    ecsGreenContainerImage,
    ecsContainerPort: numberContext(node, 'ecsContainerPort', 80),
    ecsCpu: numberContext(node, 'ecsCpu', 512),
    ecsMemoryMiB: numberContext(node, 'ecsMemoryMiB', 1024),
    ecsBlueDesiredCount: numberContext(node, 'ecsBlueDesiredCount', 1),
    ecsGreenDesiredCount: numberContext(node, 'ecsGreenDesiredCount', 0),
    blueTrafficWeight,
    greenTrafficWeight,
    logRetentionDays: numberContext(node, 'logRetentionDays', 30),
    albLogRetentionDays: numberContext(node, 'albLogRetentionDays', 90),
    alarm5xxRateThresholdPercent,
    healthCheckPath: optionalContext(node, 'healthCheckPath') ?? '/',
    certificateArn: optionalContext(node, 'certificateArn'),
    hostedZoneId,
    hostedZoneName,
    albDomainName,
    cloudFrontPriceClass: optionalContext(node, 'cloudFrontPriceClass') ?? 'PriceClass_100',
    customDomainName,
    frontendCertificateArn,
    frontendHostedZoneId: optionalContext(node, 'frontendHostedZoneId'),
    frontendHostedZoneName: optionalContext(node, 'frontendHostedZoneName'),
    removalPolicy: removalPolicyRaw,
  };
}
