import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import {
  HEALTH_CHECK_HEALTHY_COUNT,
  HEALTH_CHECK_INTERVAL_SECONDS,
  HEALTH_CHECK_TIMEOUT_SECONDS,
  HEALTH_CHECK_UNHEALTHY_COUNT,
  ECS_CIRCUIT_BREAKER_ENABLED,
} from '../config/constants';

export type DeploymentColor = 'blue' | 'green';

/**
 * Maps a retention period in days to the closest supported CloudWatch RetentionDays enum value.
 * CloudWatch only supports specific values — we pick the nearest one that is >= the requested days.
 */
function resolveRetentionDays(days: number): logs.RetentionDays {
  const supported: Array<[number, logs.RetentionDays]> = [
    [1, logs.RetentionDays.ONE_DAY],
    [3, logs.RetentionDays.THREE_DAYS],
    [5, logs.RetentionDays.FIVE_DAYS],
    [7, logs.RetentionDays.ONE_WEEK],
    [14, logs.RetentionDays.TWO_WEEKS],
    [30, logs.RetentionDays.ONE_MONTH],
    [60, logs.RetentionDays.TWO_MONTHS],
    [90, logs.RetentionDays.THREE_MONTHS],
    [120, logs.RetentionDays.FOUR_MONTHS],
    [150, logs.RetentionDays.FIVE_MONTHS],
    [180, logs.RetentionDays.SIX_MONTHS],
    [365, logs.RetentionDays.ONE_YEAR],
    [400, logs.RetentionDays.THIRTEEN_MONTHS],
    [545, logs.RetentionDays.EIGHTEEN_MONTHS],
    [731, logs.RetentionDays.TWO_YEARS],
    [1096, logs.RetentionDays.THREE_YEARS],
    [1827, logs.RetentionDays.FIVE_YEARS],
    [2557, logs.RetentionDays.SEVEN_YEARS],
    [3653, logs.RetentionDays.TEN_YEARS],
  ];

  const match = supported.find(([threshold]) => days <= threshold);
  return match ? match[1] : logs.RetentionDays.TEN_YEARS;
}

export interface BlueGreenServiceProps {
  readonly color: DeploymentColor;
  readonly cluster: ecs.ICluster;
  readonly vpc: ec2.IVpc;
  readonly securityGroup: ec2.ISecurityGroup;
  readonly containerImage: ecs.ContainerImage;
  readonly containerPort: number;
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly desiredCount: number;
  readonly healthCheckPath: string;
  readonly logRetentionDays: number;
  readonly prefix: string;
}

/**
 * BlueGreenService encapsulates everything needed for one deployment color:
 *   - CloudWatch log group
 *   - ECS task definition with the container
 *   - Fargate service
 *   - ALB target group
 *
 * Instantiated twice in BackendStack — once for blue, once for green.
 * The ALB listener's weighted forward action ties them together.
 */
export class BlueGreenService extends Construct {
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: BlueGreenServiceProps) {
    super(scope, id);

    const {
      color,
      cluster,
      vpc,
      securityGroup,
      containerImage,
      containerPort,
      cpu,
      memoryMiB,
      desiredCount,
      healthCheckPath,
      logRetentionDays,
      prefix,
    } = props;

    const colorPrefix = `${prefix}-${color}`;

    // ── Log group ─────────────────────────────────────────────────────────────
    // RemovalPolicy.RETAIN regardless of environment — logs are operational audit
    // data. We never want them destroyed automatically. The retention period is the
    // cost control lever; after N days CloudWatch auto-expires the log events.
    const logGroupName = `/ecs/${colorPrefix}`;
    const logRetention = new logs.LogRetention(this, 'LogRetention', {
      logGroupName,
      retention: resolveRetentionDays(logRetentionDays),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const logGroup = logs.LogGroup.fromLogGroupName(this, 'LogGroup', logGroupName);

    // ── Task definition ───────────────────────────────────────────────────────
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: colorPrefix,
      cpu,
      memoryLimitMiB: memoryMiB,
    });

    taskDef.addContainer('AppContainer', {
      image: containerImage,
      portMappings: [{ containerPort, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: color,
      }),
      // Surface the color as an environment variable — useful for debugging
      // which version is serving a request.
      environment: {
        DEPLOYMENT_COLOR: color,
      },
    });

    // ── Fargate service ───────────────────────────────────────────────────────
    // DeploymentControllerType.ECS (rolling) is used intentionally.
    // CodeDeploy blue/green would hand traffic shift control to CodeDeploy, making
    // CDK-managed weights impossible. Rolling updates + circuit breaker give us
    // safe in-place updates for each color, while the weighted ALB rule handles
    // the cross-color traffic split.
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: colorPrefix,
      cluster,
      taskDefinition: taskDef,
      desiredCount,
      securityGroups: [securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      enableExecuteCommand: false,
      deploymentController: {
        type: ecs.DeploymentControllerType.ECS,
      },
      circuitBreaker: ECS_CIRCUIT_BREAKER_ENABLED
        ? { enable: true, rollback: true }
        : undefined,
    });

    this.service.node.addDependency(logRetention);

    // ── Target group ──────────────────────────────────────────────────────────
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      targetGroupName: `${colorPrefix}-tg`,
      vpc,
      port: containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: healthCheckPath,
        interval: cdk.Duration.seconds(HEALTH_CHECK_INTERVAL_SECONDS),
        timeout: cdk.Duration.seconds(HEALTH_CHECK_TIMEOUT_SECONDS),
        healthyThresholdCount: HEALTH_CHECK_HEALTHY_COUNT,
        unhealthyThresholdCount: HEALTH_CHECK_UNHEALTHY_COUNT,
        healthyHttpCodes: '200-299',
      },
      // Keep a short but non-trivial drain period so rolling replacements have
      // time to finish in-flight requests without keeping old tasks around for
      // the full ALB default of 300 seconds.
      deregistrationDelay: cdk.Duration.seconds(60),
    });

    this.service.attachToApplicationTargetGroup(this.targetGroup);
  }
}
