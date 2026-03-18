import { Match, Template } from 'aws-cdk-lib/assertions';
import { FrontendStack } from '../lib/stacks/frontend-stack';
import { resolveContext } from '../lib/config/context';
import { createTestApp, TEST_ENV } from './helpers/test-app';

function buildTemplate(overrides: Record<string, unknown> = {}): Template {
  const app = createTestApp(overrides);
  const ctx = resolveContext(app.node, TEST_ENV);
  const stack = new FrontendStack(app, 'TestFrontendStack', { env: TEST_ENV, ctx });
  return Template.fromStack(stack);
}

describe('FrontendStack', () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it('S3 bucket blocks all public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('S3 bucket has no website configuration (CloudFront serves directly via OAC)', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    const hasWebsiteConfig = Object.values(buckets).some(
      (b) =>
        (b as { Properties: { WebsiteConfiguration?: unknown } }).Properties
          ?.WebsiteConfiguration !== undefined,
    );
    expect(hasWebsiteConfig).toBe(false);
  });

  it('S3 bucket enforces SSL', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
          }),
        ]),
      },
    });
  });

  it('CloudFront distribution is enabled', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ Enabled: true }),
    });
  });

  it('default behavior redirects HTTP to HTTPS', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
      }),
    });
  });

  it('distribution uses TLS 1.2 minimum protocol version when a custom certificate is provided', () => {
    const customTemplate = buildTemplate({
      customDomainName: 'www.example.com',
      frontendCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/xyz-456',
      frontendHostedZoneId: 'Z1234567890ABC',
      frontendHostedZoneName: 'example.com',
    });

    customTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        ViewerCertificate: Match.objectLike({
          MinimumProtocolVersion: 'TLSv1.2_2021',
        }),
      }),
    });
  });

  it('creates an Origin Access Control (OAC) — not the deprecated OAI', () => {
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });

  it('does not create a Route 53 record when no custom domain is configured', () => {
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
  });

  it('creates a Route 53 A record when a custom domain is configured', () => {
    const customTemplate = buildTemplate({
      customDomainName: 'www.example.com',
      frontendCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/xyz-456',
      frontendHostedZoneId: 'Z1234567890ABC',
      frontendHostedZoneName: 'example.com',
    });

    customTemplate.resourceCountIs('AWS::Route53::RecordSet', 1);
    customTemplate.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
    });
  });

  it('distribution uses the PriceClass_100 by default', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        PriceClass: 'PriceClass_100',
      }),
    });
  });

  it('has SPA error response rules for 403 and 404 returning index.html', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        ]),
      }),
    });
  });
});
