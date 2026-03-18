import { Match, Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/stacks/network-stack';
import { BackendStack } from '../lib/stacks/backend-stack';
import { resolveContext } from '../lib/config/context';
import { createTestApp, TEST_ENV } from './helpers/test-app';

function buildTemplate(overrides: Record<string, unknown> = {}): Template {
  const app = createTestApp(overrides);
  const ctx = resolveContext(app.node, TEST_ENV);

  const networkStack = new NetworkStack(app, 'TestNetworkStack', { env: TEST_ENV, ctx });

  const backendStack = new BackendStack(app, 'TestBackendStack', {
    env: TEST_ENV,
    ctx,
    vpc: networkStack.vpc,
    blueAlbSecurityGroup: networkStack.blueAlbSecurityGroup,
    greenAlbSecurityGroup: networkStack.greenAlbSecurityGroup,
    ecsSecurityGroup: networkStack.ecsSecurityGroup,
    albLogBucket: networkStack.albLogBucket,
  });

  return Template.fromStack(backendStack);
}

describe('BackendStack', () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it('creates exactly 2 ECS services (blue and green)', () => {
    template.resourceCountIs('AWS::ECS::Service', 2);
  });

  it('creates exactly 2 task definitions', () => {
    template.resourceCountIs('AWS::ECS::TaskDefinition', 2);
  });

  it('blue service has the configured desired count', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 2,
    });
  });

  it('green service has desired count of 0 (not live at rest)', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 0,
    });
  });

  it('enables the ECS deployment circuit breaker on both services', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: {
          Enable: true,
          Rollback: true,
        },
      }),
    });
  });

  it('task definitions use awslogs log driver', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          LogConfiguration: { LogDriver: 'awslogs' },
        }),
      ]),
    });
  });

  it('uses the asset-based image path by default to match the real deploy flow', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Image: Match.anyValue(),
        }),
      ]),
    });

    const taskDefs = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
    const hasLiteralPublicRegistryImage = taskDefs.some((taskDef) => {
      const containers = (
        taskDef as { Properties?: { ContainerDefinitions?: Array<{ Image?: unknown }> } }
      ).Properties?.ContainerDefinitions;

      return containers?.some(
        (container) =>
          typeof container.Image === 'string' &&
          container.Image.startsWith('public.ecr.aws/docker/library/nginx:'),
      );
    });

    expect(hasLiteralPublicRegistryImage).toBe(false);
  });

  it('sets DEPLOYMENT_COLOR in each task definition', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'DEPLOYMENT_COLOR', Value: 'blue' }),
          ]),
        }),
      ]),
    });

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'DEPLOYMENT_COLOR', Value: 'green' }),
          ]),
        }),
      ]),
    });
  });

  it('supports distinct blue and green images', () => {
    const splitImageTemplate = buildTemplate({
      ecsImageSource: 'registry',
      ecsGreenContainerImage: 'public.ecr.aws/docker/library/nginx:1.28-alpine',
    });

    splitImageTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Image: 'public.ecr.aws/docker/library/nginx:1.27-alpine',
        }),
      ]),
    });

    splitImageTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Image: 'public.ecr.aws/docker/library/nginx:1.28-alpine',
        }),
      ]),
    });
  });

  it('creates exactly 2 ALB target groups', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 2);
  });

  it('creates exactly 2 ALBs (one per color)', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 2);
  });

  it('creates exactly 2 listeners by default (one HTTP listener per ALB)', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 2);
  });

  it('does not create Route 53 records when hosted-zone context is omitted', () => {
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
  });

  it('creates two weighted Route 53 alias records by default', () => {
    const routedTemplate = buildTemplate({
      hostedZoneId: 'Z1234567890ABC',
      hostedZoneName: 'example.com',
      albDomainName: 'api.example.com',
    });

    routedTemplate.resourceCountIs('AWS::Route53::RecordSet', 2);
  });

  it('default Route 53 weights send 100% to blue and 0% to green', () => {
    const routedTemplate = buildTemplate({
      hostedZoneId: 'Z1234567890ABC',
      hostedZoneName: 'example.com',
      albDomainName: 'api.example.com',
    });

    routedTemplate.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'api.example.com.',
      Type: 'A',
      Weight: 100,
      SetIdentifier: 'test-app-test-blue',
    });

    routedTemplate.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'api.example.com.',
      Type: 'A',
      Weight: 0,
      SetIdentifier: 'test-app-test-green',
    });
  });

  it('custom traffic split (50/50) is reflected in Route 53 record weights', () => {
    const splitTemplate = buildTemplate({
      hostedZoneId: 'Z1234567890ABC',
      hostedZoneName: 'example.com',
      albDomainName: 'api.example.com',
      blueTrafficWeight: 50,
      greenTrafficWeight: 50,
    });

    splitTemplate.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'api.example.com.',
      Weight: 50,
      SetIdentifier: 'test-app-test-blue',
    });

    splitTemplate.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'api.example.com.',
      Weight: 50,
      SetIdentifier: 'test-app-test-green',
    });
  });

  it('creates an SNS topic for ALB 5xx rate alarms', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
  });

  it('creates 2 CloudWatch 5xx rate alarms with actions', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      Threshold: 5,
      AlarmActions: Match.anyValue(),
      Metrics: Match.arrayWith([
        Match.objectLike({
          Expression: 'IF(requests > 0, 100 * errors / requests, 0)',
        }),
      ]),
    });
  });

  it('CloudWatch log retention is managed explicitly', () => {
    template.resourceCountIs('Custom::LogRetention', 2);

    template.hasResourceProperties('Custom::LogRetention', {
      LogGroupName: '/ecs/test-app-test-blue',
      RetentionInDays: 30,
    });

    template.hasResourceProperties('Custom::LogRetention', {
      LogGroupName: '/ecs/test-app-test-green',
      RetentionInDays: 30,
    });
  });

  it('ALBs have access logging enabled to the S3 bucket', () => {
    const loadBalancers = Object.values(
      template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'),
    ) as Array<{
      Properties?: { LoadBalancerAttributes?: Array<{ Key?: string; Value?: unknown }> };
    }>;

    expect(loadBalancers).toHaveLength(2);

    for (const loadBalancer of loadBalancers) {
      expect(loadBalancer.Properties?.LoadBalancerAttributes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Key: 'access_logs.s3.enabled', Value: 'true' }),
          expect.objectContaining({ Key: 'access_logs.s3.bucket', Value: expect.anything() }),
          expect.objectContaining({ Key: 'access_logs.s3.prefix', Value: expect.anything() }),
        ]),
      );
    }
  });

  it('creates two HTTPS listeners and two HTTP redirect listeners when a certificate ARN is provided', () => {
    const tlsTemplate = buildTemplate({
      certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc-123',
    });

    tlsTemplate.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 4);

    const listeners = Object.values(
      tlsTemplate.findResources('AWS::ElasticLoadBalancingV2::Listener'),
    );

    const httpRedirectCount = listeners.filter((listener) => {
      const actions = (
        listener as { Properties: { DefaultActions?: Array<{ Type?: string }> } }
      ).Properties?.DefaultActions;

      return actions?.some((action) => action.Type === 'redirect');
    }).length;

    const httpsForwardCount = listeners.filter((listener) => {
      const port = (listener as { Properties: { Port?: number } }).Properties?.Port;
      const actions = (
        listener as { Properties: { DefaultActions?: Array<{ Type?: string }> } }
      ).Properties?.DefaultActions;

      return port === 443 && actions?.some((action) => action.Type === 'forward');
    }).length;

    expect(httpRedirectCount).toBe(2);
    expect(httpsForwardCount).toBe(2);
  });

  it('uses a TLS 1.2+ ALB listener policy when HTTPS is enabled', () => {
    const tlsTemplate = buildTemplate({
      certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc-123',
    });

    tlsTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      SslPolicy: 'ELBSecurityPolicy-FS-1-2-Res-2019-08',
    });
  });
});
