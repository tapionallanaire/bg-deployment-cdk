import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { ALB_HTTP_PORT, ALB_HTTPS_PORT } from '../config/constants';
import { DeploymentColor } from './blue-green-service';

export interface AlbConstructProps {
  readonly color: DeploymentColor;
  readonly prefix: string;
  readonly vpc: ec2.IVpc;
  readonly securityGroup: ec2.ISecurityGroup;
  readonly logBucket: s3.IBucket;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  /** If set, adds an HTTPS listener with this certificate. Otherwise HTTP only. */
  readonly certificateArn?: string;
}

function capitalize(color: DeploymentColor): string {
  return color.charAt(0).toUpperCase() + color.slice(1);
}

/**
 * AlbConstruct provisions one color-specific Application Load Balancer.
 *
 * Blue/green mechanism:
 *   Each deployment color gets its own ALB and target group. Route 53 weighted
 *   alias records then split traffic between those two ALBs. This matches the
 *   take-home brief literally and preserves a clean rollback path because the
 *   inactive color can keep serving the previous image unchanged.
 */
export class AlbConstruct extends Construct {
  public readonly alb: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: AlbConstructProps) {
    super(scope, id);

    const { color, prefix, vpc, securityGroup, logBucket, targetGroup, certificateArn } = props;
    const albPrefix = `${prefix}-${color}`;

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${albPrefix}-alb`,
      vpc,
      internetFacing: true,
      securityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    this.alb.logAccessLogs(logBucket, `${albPrefix}-alb`);

    if (certificateArn) {
      const certificate = acm.Certificate.fromCertificateArn(
        this,
        'AlbCertificate',
        certificateArn,
      );

      this.alb.addListener('HttpsListener', {
        port: ALB_HTTPS_PORT,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
        defaultTargetGroups: [targetGroup],
      });

      this.alb.addListener('HttpRedirectListener', {
        port: ALB_HTTP_PORT,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: String(ALB_HTTPS_PORT),
          permanent: true,
        }),
      });
    } else {
      this.alb.addListener('HttpListener', {
        port: ALB_HTTP_PORT,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultTargetGroups: [targetGroup],
      });
    }

    new cdk.CfnOutput(cdk.Stack.of(this), `${capitalize(color)}AlbDnsName`, {
      exportName: `${albPrefix}-alb-dns`,
      value: this.alb.loadBalancerDnsName,
      description: `${capitalize(color)} ALB DNS name`,
    });
  }
}
