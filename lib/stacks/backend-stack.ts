import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ecrassets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as path from 'node:path';
import { Construct } from 'constructs';
import { AlbConstruct } from '../constructs/alb-construct';
import { BlueGreenService } from '../constructs/blue-green-service';
import { ALARM_EVALUATION_PERIODS, ALARM_PERIOD_SECONDS } from '../config/constants';
import { BackendStackProps } from '../types/stack-props';

/**
 * BackendStack provisions the containerized application layer.
 *
 * Contains:
 *   - ECS cluster
 *   - Blue and green Fargate services (each with its own task definition + target group)
 *   - Blue and green internet-facing ALBs
 *   - Route 53 weighted alias records that split traffic between the two ALBs
 *   - CloudWatch 5xx rate alarms that publish to SNS
 *
 * Boundary rationale: The application stack depends on NetworkStack outputs (VPC, SGs,
 * log bucket) but is otherwise independent. This lets the application be torn down and
 * redeployed without touching VPC or networking resources, which is the expected pattern
 * during development iteration and incident response.
 */
export class BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

    const { ctx, vpc, albSecurityGroup, ecsSecurityGroup, albLogBucket } = props;
    const prefix = `${ctx.appName}-${ctx.environment}`;
    const dockerAssetPath = path.join(__dirname, '../../docker/backend');

    const resolveContainerImage = (
      color: 'blue' | 'green',
      baseImage: string,
    ): ecs.ContainerImage => {
      if (ctx.ecsImageSource === 'registry') {
        return ecs.ContainerImage.fromRegistry(baseImage);
      }

      return ecs.ContainerImage.fromAsset(dockerAssetPath, {
        buildArgs: {
          BASE_IMAGE: baseImage,
          DEPLOYMENT_COLOR: color,
        },
        // Fargate defaults to x86_64 in this stack. Force the Docker asset to the
        // same target platform so Apple Silicon local builds do not produce arm64 images
        // that fail at runtime with "exec format error".
        platform: ecrassets.Platform.LINUX_AMD64,
      });
    };

    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${prefix}-cluster`,
      vpc,
      containerInsights: true,
    });

    const blueService = new BlueGreenService(this, 'BlueService', {
      color: 'blue',
      cluster,
      vpc,
      securityGroup: ecsSecurityGroup,
      containerImage: resolveContainerImage('blue', ctx.ecsBlueContainerImage),
      containerPort: ctx.ecsContainerPort,
      cpu: ctx.ecsCpu,
      memoryMiB: ctx.ecsMemoryMiB,
      desiredCount: ctx.ecsBlueDesiredCount,
      healthCheckPath: ctx.healthCheckPath,
      logRetentionDays: ctx.logRetentionDays,
      prefix,
    });

    const greenService = new BlueGreenService(this, 'GreenService', {
      color: 'green',
      cluster,
      vpc,
      securityGroup: ecsSecurityGroup,
      containerImage: resolveContainerImage('green', ctx.ecsGreenContainerImage),
      containerPort: ctx.ecsContainerPort,
      cpu: ctx.ecsCpu,
      memoryMiB: ctx.ecsMemoryMiB,
      desiredCount: ctx.ecsGreenDesiredCount,
      healthCheckPath: ctx.healthCheckPath,
      logRetentionDays: ctx.logRetentionDays,
      prefix,
    });

    const blueAlb = new AlbConstruct(this, 'BlueAlb', {
      color: 'blue',
      prefix,
      vpc,
      securityGroup: albSecurityGroup,
      logBucket: albLogBucket,
      targetGroup: blueService.targetGroup,
      certificateArn: ctx.certificateArn,
    });

    const greenAlb = new AlbConstruct(this, 'GreenAlb', {
      color: 'green',
      prefix,
      vpc,
      securityGroup: albSecurityGroup,
      logBucket: albLogBucket,
      targetGroup: greenService.targetGroup,
      certificateArn: ctx.certificateArn,
    });

    if (ctx.hostedZoneId && ctx.hostedZoneName && ctx.albDomainName) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: ctx.hostedZoneId,
        zoneName: ctx.hostedZoneName,
      });

      new route53.ARecord(this, 'BlueWeightedAliasRecord', {
        zone: hostedZone,
        recordName: ctx.albDomainName,
        target: route53.RecordTarget.fromAlias(
          new route53targets.LoadBalancerTarget(blueAlb.alb),
        ),
        weight: ctx.blueTrafficWeight,
        setIdentifier: `${prefix}-blue`,
        comment: `Blue weighted alias for ${prefix}`,
      });

      new route53.ARecord(this, 'GreenWeightedAliasRecord', {
        zone: hostedZone,
        recordName: ctx.albDomainName,
        target: route53.RecordTarget.fromAlias(
          new route53targets.LoadBalancerTarget(greenAlb.alb),
        ),
        weight: ctx.greenTrafficWeight,
        setIdentifier: `${prefix}-green`,
        comment: `Green weighted alias for ${prefix}`,
      });

      new cdk.CfnOutput(this, 'WeightedBackendDomain', {
        exportName: `${prefix}-weighted-backend-domain`,
        value: ctx.albDomainName,
      });
    }

    const alarmTopic = new sns.Topic(this, 'Alb5xxAlarmTopic', {
      topicName: `${prefix}-alb-5xx-rate`,
      displayName: `${prefix} ALB 5xx rate alarm notifications`,
    });

    const createFiveXxRateAlarm = (
      alarmId: string,
      color: 'blue' | 'green',
      alb: elbv2.ApplicationLoadBalancer,
    ): cloudwatch.Alarm => {
      const period = cdk.Duration.seconds(ALARM_PERIOD_SECONDS);
      const fiveXxRateMetric = new cloudwatch.MathExpression({
        expression: 'IF(requests > 0, 100 * errors / requests, 0)',
        usingMetrics: {
          errors: alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
            period,
            statistic: 'Sum',
          }),
          requests: alb.metrics.requestCount({
            period,
            statistic: 'Sum',
          }),
        },
        label: `${color} ALB target 5xx rate (%)`,
        period,
      });

      const alarm = new cloudwatch.Alarm(this, alarmId, {
        alarmName: `${prefix}-${color}-alb-5xx-rate`,
        alarmDescription:
          `${color} ALB target 5xx rate is >= ${ctx.alarm5xxRateThresholdPercent}% ` +
          `for ${ALARM_EVALUATION_PERIODS} consecutive periods.`,
        metric: fiveXxRateMetric,
        threshold: ctx.alarm5xxRateThresholdPercent,
        evaluationPeriods: ALARM_EVALUATION_PERIODS,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      alarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
      return alarm;
    };

    const blueFiveXxRateAlarm = createFiveXxRateAlarm('BlueAlb5xxRateAlarm', 'blue', blueAlb.alb);
    const greenFiveXxRateAlarm = createFiveXxRateAlarm(
      'GreenAlb5xxRateAlarm',
      'green',
      greenAlb.alb,
    );

    new cdk.CfnOutput(this, 'ClusterName', {
      exportName: `${prefix}-cluster-name`,
      value: cluster.clusterName,
    });

    new cdk.CfnOutput(this, 'BlueServiceName', {
      exportName: `${prefix}-blue-service`,
      value: blueService.service.serviceName,
    });

    new cdk.CfnOutput(this, 'GreenServiceName', {
      exportName: `${prefix}-green-service`,
      value: greenService.service.serviceName,
    });

    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      exportName: `${prefix}-5xx-alarm-topic-arn`,
      value: alarmTopic.topicArn,
    });

    new cdk.CfnOutput(this, 'Blue5xxRateAlarmArn', {
      exportName: `${prefix}-blue-5xx-rate-alarm-arn`,
      value: blueFiveXxRateAlarm.alarmArn,
    });

    new cdk.CfnOutput(this, 'Green5xxRateAlarmArn', {
      exportName: `${prefix}-green-5xx-rate-alarm-arn`,
      value: greenFiveXxRateAlarm.alarmArn,
    });
  }
}
