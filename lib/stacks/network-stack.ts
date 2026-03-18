import * as cdk from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import {
  ALB_HTTP_PORT,
  ALB_HTTPS_PORT,
  AMAZON_PROVIDED_DNS_RESOLVER_CIDR,
  DNS_PORT,
  OUTBOUND_HTTPS_PORT,
} from '../config/constants';
import { NetworkStackProps } from '../types/stack-props';

/**
 * NetworkStack provisions all foundational networking resources.
 *
 * Boundary rationale: Networking changes at a fundamentally different cadence than
 * application deployments. Separating it ensures that a bad application deploy never
 * risks tearing down the VPC, and lets us update NAT gateways or subnet CIDR blocks
 * independently of service code. The ALB log bucket also lives here because it is a
 * networking concern and must outlive application stack replacements.
 *
 * Exports (via CfnOutput / direct object references passed as BackendStackProps):
 *   - vpc
 *   - albSecurityGroup
 *   - ecsSecurityGroup
 *   - albLogBucket
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly ecsSecurityGroup: ec2.SecurityGroup;
  public readonly albLogBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { ctx } = props;
    const prefix = `${ctx.appName}-${ctx.environment}`;
    const removalPolicy =
      ctx.removalPolicy === 'RETAIN' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // ── VPC ─────────────────────────────────────────────────────────────────
    // Explicit subnet config gives us full control over naming and CIDR assignment.
    // One NAT gateway by default (cost lever) — set vpcNatGateways=2 in prod
    // for AZ-local HA.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${prefix}-vpc`,
      maxAzs: ctx.vpcMaxAzs,
      natGateways: ctx.vpcNatGateways,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    // ── Security groups ──────────────────────────────────────────────────────
    // ALB SG: internet-facing, must accept HTTP and HTTPS from anywhere.
    // Outbound is unrestricted on the ALB SG — restricting it to the ECS SG creates a
    // CloudFormation circular dependency (ALB SG egress → ECS SG, ECS SG ingress → ALB SG).
    // The meaningful restriction is the ECS SG's inbound rule, which only allows traffic
    // from this ALB SG. ALB outbound is effectively scoped to its registered targets anyway.
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-alb-sg`,
      description: 'ALB - inbound HTTP/HTTPS from internet',
      allowAllOutbound: true,
    });

    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(ALB_HTTP_PORT),
      'Allow HTTP from internet',
    );

    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(ALB_HTTPS_PORT),
      'Allow HTTPS from internet',
    );

    // ECS SG: private, must accept traffic from the ALB only on the container port.
    // Egress: allow VPC-local HTTPS plus DNS to the VPC resolver. Fargate uses the
    // AmazonProvidedDNS link-local address for name resolution, so both the VPC CIDR
    // and the resolver /32 are allowed explicitly.
    this.ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-ecs-sg`,
      description: 'ECS Fargate tasks - inbound from ALB SG only, outbound HTTPS for ECR',
      allowAllOutbound: false,
    });

    const endpointSecurityGroup = new ec2.SecurityGroup(this, 'VpcEndpointSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-vpce-sg`,
      description: 'Allows ECS tasks to reach PrivateLink endpoints over HTTPS',
      allowAllOutbound: true,
    });

    this.ecsSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(this.albSecurityGroup.securityGroupId),
      ec2.Port.tcp(ctx.ecsContainerPort),
      'Allow traffic from ALB only',
    );

    this.ecsSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(OUTBOUND_HTTPS_PORT),
      'Allow HTTPS outbound only inside the VPC for interface endpoints',
    );

    this.ecsSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.udp(DNS_PORT),
      'Allow UDP DNS queries to the VPC resolver',
    );

    this.ecsSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(DNS_PORT),
      'Allow TCP DNS queries to the VPC resolver',
    );

    this.ecsSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(AMAZON_PROVIDED_DNS_RESOLVER_CIDR),
      ec2.Port.udp(DNS_PORT),
      'Allow UDP DNS queries to AmazonProvidedDNS',
    );

    this.ecsSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(AMAZON_PROVIDED_DNS_RESOLVER_CIDR),
      ec2.Port.tcp(DNS_PORT),
      'Allow TCP DNS queries to AmazonProvidedDNS',
    );

    // Private task networking is intentionally closed down to PrivateLink and S3.
    // This removes the need for 0.0.0.0/0 egress on the ECS task ENIs.
    const s3GatewayEndpoint = this.vpc.addGatewayEndpoint('S3GatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });

    // ECR stores image layers in S3. The tasks therefore need HTTPS egress to the
    // region's AWS-managed S3 prefix list in addition to VPC-local interface endpoints.
    // The prefix list ID is region-specific, so we resolve it at deploy time instead of
    // hardcoding it or pushing it into user-supplied context.
    const s3PrefixListLookup = new cr.AwsCustomResource(this, 'S3PrefixListLookup', {
      onUpdate: {
        service: 'EC2',
        action: 'describeManagedPrefixLists',
        parameters: {
          Filters: [
            {
              Name: 'prefix-list-name',
              Values: [`com.amazonaws.${cdk.Stack.of(this).region}.s3`],
            },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of(
          `s3-prefix-list-${cdk.Stack.of(this).region}`,
        ),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    const s3PrefixListEgress = new ec2.CfnSecurityGroupEgress(this, 'EcsSecurityGroupS3Egress', {
      groupId: this.ecsSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: OUTBOUND_HTTPS_PORT,
      toPort: OUTBOUND_HTTPS_PORT,
      destinationPrefixListId: s3PrefixListLookup.getResponseField('PrefixLists.0.PrefixListId'),
      description: 'Allow HTTPS outbound to the S3 managed prefix list for ECR layer downloads',
    });

    s3PrefixListEgress.addDependency(s3GatewayEndpoint.node.defaultChild as ec2.CfnVPCEndpoint);

    this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [endpointSecurityGroup],
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('EcrDockerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [endpointSecurityGroup],
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [endpointSecurityGroup],
      privateDnsEnabled: true,
    });

    // ── ALB access log bucket ─────────────────────────────────────────────────
    // Retention: we use an S3 lifecycle rule rather than relying on stack removal
    // so logs survive even if someone deletes the stack (operator error protection).
    // RemovalPolicy.RETAIN in prod — do NOT auto-delete audit logs.
    this.albLogBucket = new s3.Bucket(this, 'AlbLogBucket', {
      bucketName: `${prefix}-alb-logs-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy,
      // autoDeleteObjects only fires on DESTROY; harmless when RETAIN.
      autoDeleteObjects: ctx.removalPolicy === 'DESTROY',
      lifecycleRules: [
        {
          id: 'expire-alb-logs',
          expiration: cdk.Duration.days(ctx.albLogRetentionDays),
          enabled: true,
        },
      ],
    });

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'VpcId', {
      exportName: `${prefix}-vpc-id`,
      value: this.vpc.vpcId,
    });

    new cdk.CfnOutput(this, 'AlbLogBucketName', {
      exportName: `${prefix}-alb-log-bucket`,
      value: this.albLogBucket.bucketName,
    });
  }
}
