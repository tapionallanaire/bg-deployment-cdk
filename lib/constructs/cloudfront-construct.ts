import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'node:path';
import { Construct } from 'constructs';

export interface CloudFrontConstructProps {
  readonly prefix: string;
  readonly priceClass: string;
  readonly removalPolicy: cdk.RemovalPolicy;
  /** If set, configures a custom domain + HTTPS certificate on the distribution. */
  readonly customDomainName?: string;
  /** ACM certificate ARN — MUST be in us-east-1. Required when customDomainName is set. */
  readonly certificateArn?: string;
  /** Route 53 hosted zone for the A alias record. Required when customDomainName is set. */
  readonly hostedZoneId?: string;
  readonly hostedZoneName?: string;
}

/**
 * CloudFrontConstruct provisions:
 *   - S3 bucket for static assets (no public access, no website hosting mode)
 *   - CloudFront Origin Access Control (OAC) — the modern successor to OAI
 *   - CloudFront distribution with HTTPS-only policy and HTTP redirect
 *   - Optional: custom domain with ACM cert + Route 53 A record
 *
 * OAC vs OAI: OAI is deprecated and doesn't support SSE-KMS or POST/PUT requests.
 *   OAC is the current AWS recommendation and is supported by aws-cloudfront-origins
 *   via S3BucketOrigin.withOriginAccessControl().
 */
export class CloudFrontConstruct extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CloudFrontConstructProps) {
    super(scope, id);

    const {
      prefix,
      priceClass,
      removalPolicy,
      customDomainName,
      certificateArn,
      hostedZoneId,
      hostedZoneName,
    } = props;

    // ── S3 bucket ─────────────────────────────────────────────────────────────
    // No website hosting — CloudFront fetches objects directly via OAC.
    // Public access is fully blocked; the bucket policy grants CloudFront access only.
    //
    // RemovalPolicy rationale:
    //   dev  → DESTROY (clean teardown)
    //   prod → RETAIN (static assets may be referenced by cached CDN URLs;
    //                  accidental deletion would cause 403s for all cached users)
    this.bucket = new s3.Bucket(this, 'AssetsBucket', {
      bucketName: `${prefix}-frontend-${cdk.Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy,
      autoDeleteObjects: removalPolicy === cdk.RemovalPolicy.DESTROY,
    });

    // ── CloudFront price class ─────────────────────────────────────────────────
    const priceClassMap: Record<string, cloudfront.PriceClass> = {
      PriceClass_100: cloudfront.PriceClass.PRICE_CLASS_100,
      PriceClass_200: cloudfront.PriceClass.PRICE_CLASS_200,
      PriceClass_All: cloudfront.PriceClass.PRICE_CLASS_ALL,
    };

    const resolvedPriceClass =
      priceClassMap[priceClass] ?? cloudfront.PriceClass.PRICE_CLASS_100;

    // ── Certificate (optional) ────────────────────────────────────────────────
    let certificate: acm.ICertificate | undefined;

    if (certificateArn) {
      // Must be in us-east-1 — CloudFront requires the cert to be in that region.
      // If you are deploying to a different region, create the cert in us-east-1
      // via a separate stack or the ACM console, then paste the ARN into context.
      certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', certificateArn);
    }

    // ── CloudFront distribution ───────────────────────────────────────────────
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${prefix} frontend`,
      priceClass: resolvedPriceClass,
      defaultRootObject: 'index.html',
      domainNames: customDomainName ? [customDomainName] : undefined,
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        compress: true,
      },
      // SPA support: serve index.html for 403/404 so client-side routing works.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // ── Route 53 alias (optional) ─────────────────────────────────────────────
    if (customDomainName && hostedZoneId && hostedZoneName) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId,
        zoneName: hostedZoneName,
      });

      new route53.ARecord(this, 'CloudFrontAliasRecord', {
        zone: hostedZone,
        recordName: customDomainName,
        target: route53.RecordTarget.fromAlias(
          new route53targets.CloudFrontTarget(this.distribution),
        ),
        ttl: cdk.Duration.seconds(60),
      });
    }

    // ── Static asset deployment ──────────────────────────────────────────────
    // Keep the frontend path fully CDK-driven by publishing the checked-in
    // static site during stack deployment instead of relying on a manual `s3 sync`.
    new s3deploy.BucketDeployment(this, 'FrontendAssetDeployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../frontend-site'))],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      prune: true,
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(cdk.Stack.of(this), 'DistributionDomain', {
      exportName: `${prefix}-cf-domain`,
      value: this.distribution.distributionDomainName,
      description: 'CloudFront distribution domain — use this URL to access the frontend',
    });

    new cdk.CfnOutput(cdk.Stack.of(this), 'DistributionId', {
      exportName: `${prefix}-cf-id`,
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID — used for cache invalidations',
    });

    new cdk.CfnOutput(cdk.Stack.of(this), 'FrontendBucket', {
      exportName: `${prefix}-frontend-bucket`,
      value: this.bucket.bucketName,
      description: 'S3 bucket — sync static assets here after build',
    });
  }
}
