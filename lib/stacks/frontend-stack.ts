import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CloudFrontConstruct } from '../constructs/cloudfront-construct';
import { FrontendStackProps } from '../types/stack-props';

/**
 * FrontendStack provisions the static asset delivery layer.
 *
 * Boundary rationale: Frontend deployments (S3 sync + CloudFront invalidation)
 * are completely independent of backend ECS deployments. Separating this stack
 * means a bad frontend deploy never risks touching ECS services, and vice versa.
 *
 * CloudFront note: distributions are global AWS resources but are managed in the
 * stack's region. The ACM certificate for a custom domain MUST be in us-east-1.
 * If you need cross-region cert management, provision it in a dedicated
 * us-east-1 stack and pass the ARN via context.
 */
export class FrontendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const { ctx } = props;
    const prefix = `${ctx.appName}-${ctx.environment}`;
    const removalPolicy =
      ctx.removalPolicy === 'RETAIN' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    new CloudFrontConstruct(this, 'CloudFront', {
      prefix,
      priceClass: ctx.cloudFrontPriceClass,
      removalPolicy,
      customDomainName: ctx.customDomainName,
      certificateArn: ctx.frontendCertificateArn,
      hostedZoneId: ctx.frontendHostedZoneId,
      hostedZoneName: ctx.frontendHostedZoneName,
    });
  }
}
