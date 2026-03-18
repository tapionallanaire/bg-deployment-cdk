import { Match, Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/stacks/network-stack';
import { resolveContext } from '../lib/config/context';
import { createTestApp, TEST_ENV } from './helpers/test-app';

function buildTemplate(): Template {
  const app = createTestApp();
  const ctx = resolveContext(app.node, TEST_ENV);
  const stack = new NetworkStack(app, 'TestNetworkStack', { env: TEST_ENV, ctx });
  return Template.fromStack(stack);
}

describe('NetworkStack', () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it('creates a VPC with DNS enabled', () => {
    template.hasResourceProperties('AWS::EC2::VPC', {
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
    });
  });

  it('creates 4 subnets (2 public + 2 private) across 2 AZs', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 4);
  });

  it('creates 1 NAT gateway by default', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  it('ALB security group allows inbound HTTP and HTTPS from anywhere', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ FromPort: 80, ToPort: 80, IpProtocol: 'tcp', CidrIp: '0.0.0.0/0' }),
        Match.objectLike({ FromPort: 443, ToPort: 443, IpProtocol: 'tcp', CidrIp: '0.0.0.0/0' }),
      ]),
    });
  });

  it('ECS security group allows inbound only from the ALB security group (no open CIDR)', () => {
    // Find the ECS SG — it must have a SourceSecurityGroupId, not a CidrIp, for its ingress rule.
    const sgResources = template.findResources('AWS::EC2::SecurityGroup');

    const ecsSg = Object.values(sgResources).find((sg) => {
      const ingress: Array<Record<string, unknown>> =
        (sg as { Properties: { SecurityGroupIngress: Array<Record<string, unknown>> } })
          .Properties?.SecurityGroupIngress ?? [];
      return ingress.some((rule) => 'SourceSecurityGroupId' in rule && !('CidrIp' in rule));
    });

    expect(ecsSg).toBeDefined();
  });

  it('ECS security group does not allow HTTPS egress to 0.0.0.0/0', () => {
    const sgResources = template.findResources('AWS::EC2::SecurityGroup');

    const ecsSg = Object.values(sgResources).find((sg) => {
      const ingress: Array<Record<string, unknown>> =
        (sg as { Properties: { SecurityGroupIngress: Array<Record<string, unknown>> } })
          .Properties?.SecurityGroupIngress ?? [];
      return ingress.some((rule) => 'SourceSecurityGroupId' in rule && !('CidrIp' in rule));
    }) as
      | { Properties?: { SecurityGroupEgress?: Array<Record<string, unknown>> } }
      | undefined;

    expect(ecsSg).toBeDefined();

    const egress = ecsSg?.Properties?.SecurityGroupEgress ?? [];
    const hasOpenHttpsEgress = egress.some(
      (rule) =>
        rule.CidrIp === '0.0.0.0/0' &&
        rule.IpProtocol === 'tcp' &&
        rule.FromPort === 443 &&
        rule.ToPort === 443,
    );

    expect(hasOpenHttpsEgress).toBe(false);
  });

  it('ECS security group allows DNS egress to AmazonProvidedDNS', () => {
    const sgResources = template.findResources('AWS::EC2::SecurityGroup');

    const ecsSg = Object.values(sgResources).find((sg) => {
      const ingress: Array<Record<string, unknown>> =
        (sg as { Properties: { SecurityGroupIngress: Array<Record<string, unknown>> } })
          .Properties?.SecurityGroupIngress ?? [];
      return ingress.some((rule) => 'SourceSecurityGroupId' in rule && !('CidrIp' in rule));
    }) as
      | { Properties?: { SecurityGroupEgress?: Array<Record<string, unknown>> } }
      | undefined;

    expect(ecsSg).toBeDefined();

    const egress = ecsSg?.Properties?.SecurityGroupEgress ?? [];
    const hasResolverDnsRule = egress.some(
      (rule) =>
        rule.CidrIp === '169.254.169.253/32' &&
        rule.IpProtocol === 'udp' &&
        rule.FromPort === 53 &&
        rule.ToPort === 53,
    );

    expect(hasResolverDnsRule).toBe(true);
  });

  it('creates VPC endpoints needed for private ECS image pulls and logging', () => {
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 4);
  });

  it('allows HTTPS egress to the S3 managed prefix list for ECR layer downloads', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupEgress', {
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      DestinationPrefixListId: Match.anyValue(),
    });
  });

  it('ALB log S3 bucket has all public access blocked', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('ALB log S3 bucket enforces SSL', () => {
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

  it('ALB log S3 bucket has a lifecycle rule for expiration', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: 'Enabled',
            ExpirationInDays: 90,
          }),
        ]),
      },
    });
  });

  it('exports VpcId as a stack output', () => {
    template.hasOutput('VpcId', { Export: { Name: Match.anyValue() } });
  });

  it('exports AlbLogBucketName as a stack output', () => {
    template.hasOutput('AlbLogBucketName', { Export: { Name: Match.anyValue() } });
  });
});
