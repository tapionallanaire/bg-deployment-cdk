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

type SecurityGroupResource = {
  Properties?: {
    GroupDescription?: string;
    SecurityGroupIngress?: Array<Record<string, unknown>>;
    SecurityGroupEgress?: Array<Record<string, unknown>>;
  };
};

function findSecurityGroup(
  template: Template,
  descriptionFragment: string,
): SecurityGroupResource | undefined {
  const resources = template.findResources('AWS::EC2::SecurityGroup');

  return Object.values(resources).find((resource) =>
    ((resource as SecurityGroupResource).Properties?.GroupDescription ?? '').includes(
      descriptionFragment,
    ),
  ) as SecurityGroupResource | undefined;
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

  it('creates separate blue and green ALB security groups with public HTTP/HTTPS ingress', () => {
    const blueAlbSg = findSecurityGroup(template, 'blue ALB');
    const greenAlbSg = findSecurityGroup(template, 'green ALB');

    expect(blueAlbSg).toBeDefined();
    expect(greenAlbSg).toBeDefined();

    for (const albSg of [blueAlbSg, greenAlbSg]) {
      expect(albSg?.Properties?.SecurityGroupIngress).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            FromPort: 80,
            ToPort: 80,
            IpProtocol: 'tcp',
            CidrIp: '0.0.0.0/0',
          }),
          expect.objectContaining({
            FromPort: 443,
            ToPort: 443,
            IpProtocol: 'tcp',
            CidrIp: '0.0.0.0/0',
          }),
        ]),
      );
    }
  });

  it('ECS security group allows inbound only from the two ALB security groups (no open CIDR)', () => {
    const ecsSg = findSecurityGroup(template, 'ECS Fargate tasks');

    expect(ecsSg).toBeDefined();

    const ingress = ecsSg?.Properties?.SecurityGroupIngress ?? [];
    expect(ingress).toHaveLength(2);
    expect(
      ingress.every((rule) => 'SourceSecurityGroupId' in rule && !('CidrIp' in rule)),
    ).toBe(true);
  });

  it('ECS security group does not allow HTTPS egress to 0.0.0.0/0', () => {
    const ecsSg = findSecurityGroup(template, 'ECS Fargate tasks');

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
    const ecsSg = findSecurityGroup(template, 'ECS Fargate tasks');

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

  it('interface endpoint security group only allows inbound HTTPS from ECS tasks', () => {
    const endpointSg = findSecurityGroup(template, 'PrivateLink endpoints');

    expect(endpointSg).toBeDefined();
    expect(endpointSg?.Properties?.SecurityGroupIngress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          FromPort: 443,
          ToPort: 443,
          IpProtocol: 'tcp',
          SourceSecurityGroupId: expect.anything(),
        }),
      ]),
    );

    const egress = endpointSg?.Properties?.SecurityGroupEgress ?? [];
    const hasUsableOutboundRule = egress.some(
      (rule) =>
        rule.IpProtocol !== 'icmp' ||
        rule.CidrIp !== '255.255.255.255/32' ||
        rule.Description !== 'Disallow all traffic',
    );

    expect(hasUsableOutboundRule).toBe(false);
  });

  it('allows HTTPS egress to the S3 managed prefix list for ECR layer downloads', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupEgress', {
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      DestinationPrefixListId: Match.anyValue(),
    });
  });

  it('uses a least-privilege IAM policy for the S3 prefix list lookup', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ec2:DescribeManagedPrefixLists',
            Effect: 'Allow',
            Resource: '*',
          }),
        ]),
      },
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
