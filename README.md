# Blue/Green Deployment Pipeline — AWS CDK (TypeScript)

This repository implements a small but fully automated blue/green deployment setup in AWS CDK. The backend runs on ECS Fargate, the frontend is served from S3 through CloudFront, and the design goal is to keep all infrastructure changes in code rather than in the AWS console. Traffic changes, capacity changes, and deployment version changes are all intended to flow through CDK context and `cdk deploy`.

## How to Deploy from Scratch

The setup assumes the AWS CLI is configured, Node.js 18 or newer is installed, Docker is installed and running, and CDK v2 is available globally. The account and region also need to be bootstrapped first.

```bash
cdk bootstrap aws://<account-id>/<region>
```

After that, clone the repository and install dependencies.

```bash
git clone <repo>
cd bg-deployment-cdk
npm install
```

If a simple local shell setup is useful, `.env.example` can be copied to `.env` and sourced before running AWS or CDK commands. This is optional and documented explicitly because the project does not auto-load `.env`.

The repository already includes a working default context in `cdk.json`, so the checked-in stack names are `bg-app-dev-network`, `bg-app-dev-backend`, and `bg-app-dev-frontend`. Stack names always follow the pattern `<appName>-<environment>-<stack>`. If `appName` or `environment` is changed, the commands below need to be updated to match, and `cdk ls` is the quickest way to confirm the exact names.

To customize the deployment, the most important context values are the application name, the environment name, and the blue and green images. The full Route 53 weighted backend routing flow also requires the hosted zone values and backend hostname. That path is implemented in CDK, but it only becomes testable when a real hosted zone and backend hostname are available in the target account.

```json
{
  "context": {
    "appName": "bg-app",
    "environment": "dev",
    "ecsBlueContainerImage": "public.ecr.aws/docker/library/nginx:1.27-alpine",
    "ecsGreenContainerImage": "public.ecr.aws/docker/library/nginx:1.28-alpine",
    "hostedZoneId": "Z123EXAMPLE",
    "hostedZoneName": "example.com",
    "albDomainName": "api.example.com"
  }
}
```

If HTTPS is needed on the backend, `certificateArn` should also be set. If a frontend custom domain is needed, `customDomainName`, `frontendCertificateArn`, `frontendHostedZoneId`, and `frontendHostedZoneName` should also be set. If the environment is being treated as persistent rather than disposable, `removalPolicy` should be set to `RETAIN`.

Before deploying anything, the tests should be run. These are CDK assertion tests, so they do not deploy resources or call AWS APIs.

```bash
npm test
```

The stacks can then be synthesized locally so the generated templates can be reviewed.

```bash
cdk synth
cdk ls
```

Once that looks right, either all stacks or each stack individually can be deployed.

```bash
CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text) \
CDK_DEFAULT_REGION=$(aws configure get region) \
cdk deploy --all
```

```bash
cdk deploy bg-app-dev-network
cdk deploy bg-app-dev-backend
cdk deploy bg-app-dev-frontend
```

The frontend stack deploys the checked-in static site from `frontend-site/` into the S3 bucket and invalidates CloudFront as part of the same CDK deployment, so there is no separate `s3 sync` step.

## How to Clean Up

After everything has been verified, the stacks can be removed in reverse dependency order.

```bash
cdk destroy bg-app-dev-frontend bg-app-dev-backend bg-app-dev-network --force
```

If the context is changed and the stack names are different, `cdk ls` is the quickest way to confirm the exact names before destroying them.

The S3 buckets follow the configured `removalPolicy`, so in the default dev configuration they are destroyed automatically. The ECS CloudWatch log groups are intentionally retained even when the stacks are deleted, so they should only be removed manually if that history is no longer needed.

## How to Switch from Blue to Green

The blue/green mechanism applies to the backend only. The frontend is a static S3 and CloudFront delivery path and is deployed independently as a normal static site update.

The safest sequence is to deploy the new version onto green first while blue still receives all production traffic.

```bash
cdk deploy bg-app-dev-backend \
  --context ecsGreenContainerImage=public.ecr.aws/docker/library/nginx:1.28-alpine \
  --context ecsGreenDesiredCount=1 \
  --context blueTrafficWeight=100 \
  --context greenTrafficWeight=0
```

Once green is healthy, traffic can be cut over completely.

```bash
cdk deploy bg-app-dev-backend \
  --context blueTrafficWeight=0 \
  --context greenTrafficWeight=100
```

That cutover only affects traffic that arrives through the shared Route 53 record. If the blue or green ALB DNS names are tested directly, those requests will still go straight to those ALBs, which is expected. In the exercise account used for this submission, `hostedZoneId`, `hostedZoneName`, and `albDomainName` were not set because no hosted zone and backend hostname were available. That means the blue and green ALBs could be validated independently, but Route 53 cutover was not validated end to end in this account.

If blue should be scaled down after the new version has had time to soak, that can be done with another backend deploy.

```bash
cdk deploy bg-app-dev-backend \
  --context ecsBlueDesiredCount=0 \
  --context blueTrafficWeight=0 \
  --context greenTrafficWeight=100
```

For a more cautious rollout, the bonus script performs repeated `cdk deploy` calls with stepped Route 53 weights, so the state stays inside CloudFormation instead of drifting through direct AWS API changes.

```bash
npx ts-node scripts/shift-traffic.ts \
  --stack-name bg-app-dev-backend \
  --start-green-weight 0 \
  --target-green-weight 100 \
  --step 10 \
  --interval-seconds 120
```

## How to Verify Blue/Green Deployments

The verification flow is easiest to follow as a sequence.

1. First, get the backend outputs so the ALB DNS names are available locally.

```bash
aws cloudformation describe-stacks \
  --stack-name bg-app-dev-backend \
  --query 'Stacks[0].Outputs' \
  --output table
```

2. On the initial deploy, confirm that blue is live and green is idle.

```bash
aws ecs describe-services \
  --cluster bg-app-dev-cluster \
  --services bg-app-dev-blue bg-app-dev-green \
  --query 'services[].{serviceName:serviceName,desiredCount:desiredCount,runningCount:runningCount,pendingCount:pendingCount,status:status}' \
  --output table
```

At this point the expected state is:
- `bg-app-dev-blue` has `desiredCount=1` and `runningCount=1`
- `bg-app-dev-green` has `desiredCount=0` and `runningCount=0`

That is the intended rest state for this exercise. Blue is serving traffic, while green exists as a deployment slot without paying for an idle task all the time.

3. Test both ALBs directly.

```bash
curl -i http://<blue-alb-dns>
curl -i http://<green-alb-dns>
```

On the initial deploy, the blue ALB should return the blue page. The green ALB will usually return `503 Service Temporarily Unavailable`. That is expected because green already has its own ALB and target group, but the green service is idle so there are no registered targets behind that target group yet.

4. Deploy a version onto green without shifting traffic yet.

```bash
cdk deploy bg-app-dev-backend \
  --context ecsGreenContainerImage=public.ecr.aws/docker/library/nginx:1.28-alpine \
  --context ecsGreenDesiredCount=1 \
  --context blueTrafficWeight=100 \
  --context greenTrafficWeight=0
```

5. Confirm that green is now active.

```bash
aws ecs describe-services \
  --cluster bg-app-dev-cluster \
  --services bg-app-dev-blue bg-app-dev-green \
  --query 'services[].{serviceName:serviceName,desiredCount:desiredCount,runningCount:runningCount,pendingCount:pendingCount,status:status}' \
  --output table
```

At this point the expected state is:
- `bg-app-dev-blue` is still running and still carries all traffic
- `bg-app-dev-green` now has `desiredCount=1` and `runningCount=1`

6. Confirm that green registered a healthy target.

```bash
aws elbv2 describe-target-groups \
  --names bg-app-dev-green-tg \
  --query 'TargetGroups[0].TargetGroupArn' \
  --output text
```

```bash
aws elbv2 describe-target-health \
  --target-group-arn <green-target-group-arn>
```

That should show at least one target in `healthy` state.

7. Test the green ALB directly.

```bash
curl -i http://<green-alb-dns>
```

At that point the green ALB should return the green page, which proves that the green environment is healthy before any traffic is shifted.

8. Only after that, if Route 53 is configured, shift traffic by changing `blueTrafficWeight` and `greenTrafficWeight` with another `cdk deploy`.

That last point matters because direct ALB verification is not the same thing as Route 53 verification. Route 53 weighting only matters when requests arrive through the shared backend hostname.

In this submission, that shared hostname was not available because `hostedZoneId`, `hostedZoneName`, and `albDomainName` were not set in the exercise account. The Route 53 weighted-record path is implemented in CDK, but without those values there is no shared record to test. For that reason, the verification in this account focused on proving that blue and green each worked correctly through their own ALB endpoints.

## Architecture Overview

At a high level, the backend has two independent paths, one for blue and one for green. Route 53 sits in front and decides how much traffic goes to each path by using weighted alias records. Each color has its own ALB, its own target group, and its own ECS service. That costs a little more than sharing a single ALB, but it makes the blue/green story much cleaner because each color is a real standalone endpoint. Both ALBs send their access logs to an S3 bucket, and each ALB has its own CloudWatch 5xx rate alarm wired to SNS so unhealthy behavior is visible per color instead of being mixed together. The ECS tasks live in private subnets and use VPC endpoints for ECR, S3, and CloudWatch Logs so I do not have to leave `0.0.0.0/0` egress open on the private task security group. The frontend is separate from all of that. Static files go into a private S3 bucket, CloudFront reads from it through Origin Access Control, and if a domain is available it can be attached through Route 53 and ACM.

## Architecture Decisions

The main architecture decision I made was to optimize for clarity and rollback safety over the absolute cheapest possible design. The details below are the choices that shaped the final structure.

I split the stacks by how I expect them to change. The network stack owns the VPC, the subnets, the NAT gateway, the ALB security groups, the ECS security group, and the ALB log bucket because those resources feel foundational and change less often. The backend stack owns the ECS cluster, both deployment colors, the two ALBs, the Route 53 weighted records, and the backend alarms because that is the part I expect to redeploy while iterating on application releases. The frontend stack is separate because I do not want a frontend change to have any chance of disturbing the backend deployment path.

The biggest design choice was using two ALBs. If this were purely an optimization exercise, I probably would have used one ALB with weighted forwarding and saved some cost. I did not do that here because the brief explicitly calls for Route 53 weighted routing records. To make Route 53 weighting meaningful, blue and green need to be distinct endpoints, so I gave each color its own ALB.

I also kept the images separate on purpose. Blue uses `ecsBlueContainerImage` and green uses `ecsGreenContainerImage`. That sounds simple, but it matters. A rollback only feels real if blue can continue serving the old version while green is tested with the new one. If both colors always point to the same image, the deployment may look blue/green on paper but it is not really giving you rollback safety.

I decided not to use CodeDeploy ECS blue/green for this exercise. CodeDeploy is a valid production choice, but it hides part of the traffic-shift logic behind the service itself. For a take-home, I thought it was better to keep the mechanism explicit and easy to review in code, so Route 53 weights plus CDK context felt like the clearest solution.

I also tightened the private networking so the ECS tasks do not need open internet egress. Instead of pulling their runtime image directly from a public registry, CDK builds the backend as a Docker asset and publishes it to private ECR during deployment. Inside the VPC, the tasks reach ECR, S3, and CloudWatch Logs through VPC endpoints, which keeps the private security group scoped to VPC-local HTTPS and DNS only.

## Blue/Green Mechanism

Traffic shifting is controlled by two Route 53 weighted alias records that share the same record name. If blue has weight `100` and green has weight `0`, all traffic goes to blue. If they are both `50`, traffic is split evenly. If green is `100`, then green is fully live. Those weights come directly from CDK context, so shifting traffic is just a backend deploy with different values.

In practice, the deployment flow is simple. The initial deploy leaves blue live and green idle, which means blue has running tasks and green is only a prepared slot with a target group but no registered targets yet. I then deploy the new version to green while blue still carries all production traffic. Once green is healthy and looks good, I start moving traffic over. If I want to be careful, I do that in stages. If I am confident, I cut over all at once. Blue stays there as an immediate fallback until I decide it is safe to scale it down.

In this account, the weighted-record logic was implemented but not exercised end to end because no hosted zone and backend hostname were available. Without those values, there is no shared Route 53 record, so changing `blueTrafficWeight` and `greenTrafficWeight` does not create a user-visible routing change by itself. The account was therefore used to validate each color directly through its own ALB, while the Route 53 behavior remains a documented CDK path for an account that has DNS available.

If blue is still running, rollback is just restoring the weights to `100/0`.

```bash
cdk deploy bg-app-dev-backend \
  --context blueTrafficWeight=100 \
  --context greenTrafficWeight=0
```

If I already scaled blue down, then rollback is still one deploy, but I also bring blue capacity back in the same change.

```bash
cdk deploy bg-app-dev-backend \
  --context ecsBlueDesiredCount=1 \
  --context blueTrafficWeight=100 \
  --context greenTrafficWeight=0
```

That is the main reason I like this setup for the exercise. The rollback story is boring, and boring is what I want from infrastructure during an incident.

## What Is Not Implemented

There are a few things I intentionally left out. I did not deploy custom domains or make backend HTTPS mandatory because I do not have a domain and matching ACM certificates available for this account, and the frontend path would also require a certificate in `us-east-1`. The backend Route 53 weighted-routing path is implemented in CDK, but I did not validate it end to end in this account because I do not have a hosted zone and backend hostname available for the exercise. In this account, the verification stopped at the blue and green ALBs themselves rather than a shared Route 53 hostname. I also hit an AWS account verification restriction when creating a CloudFront distribution in this account. The frontend stack is implemented in CDK, but waiting for AWS to complete account verification was outside the four-hour exercise budget, so I could not fully validate the frontend deployment path in this account. I also left out CI/CD and ECS auto-scaling so I could keep the time budget focused on the core infrastructure and make the blue/green flow easier to demonstrate. The gradual traffic-shift script still requires operator judgment between steps, but all traffic changes remain CDK-driven and do not require manual console changes.

## Doubts

One assumption I made was that blue/green applies to the backend only. My reading of the brief was that the weighted traffic-shift requirement is tied to the ALB in front of ECS, while the frontend is a separate static site served from S3 through CloudFront. I documented that assumption here rather than stretching the frontend into a second blue/green system that the brief did not clearly ask for.

## Removal Policy Decisions

The ALB log bucket and the frontend assets bucket both follow the shared `removalPolicy` context. In a throwaway dev environment, I prefer `DESTROY` because it keeps cleanup easy and avoids paying to retain low-value data. In a longer-lived environment, I would switch those buckets to `RETAIN` because access logs are useful operational history and frontend objects may still be referenced by cached content. The ECS CloudWatch log groups are always retained. I made that choice because log retention already controls storage cost, and I would rather keep the log groups around than lose the evidence of why a deployment failed.

## Context Reference

The most important context values are `appName` and `environment`, which drive naming across the stacks. `ecsBlueContainerImage` and `ecsGreenContainerImage` define the base images for each color. The default `ecsImageSource` is `asset`, which means CDK builds and publishes a private ECR image during deployment. There is also a `registry` mode, mainly to keep unit tests simple and offline. The older `ecsContainerImage` key is still accepted as a fallback for blue so the project stays backward compatible. `ecsBlueDesiredCount` and `ecsGreenDesiredCount` control how many tasks each color runs. `blueTrafficWeight` and `greenTrafficWeight` control the Route 53 split, but they only become meaningful when `hostedZoneId`, `hostedZoneName`, and `albDomainName` are also set so the shared backend record can be created. `certificateArn` enables HTTPS on the backend ALBs. `logRetentionDays`, `albLogRetentionDays`, and `alarm5xxRateThresholdPercent` control the main observability defaults. `removalPolicy` controls whether stateful S3 buckets are destroyed or retained. The remaining frontend-specific values are `cloudFrontPriceClass`, `customDomainName`, `frontendCertificateArn`, `frontendHostedZoneId`, and `frontendHostedZoneName`.

## CloudWatch Alarm Justification

Each ALB gets its own 5xx rate alarm. I deliberately used a rate rather than a raw error count because a fixed count gets less meaningful as traffic changes. The alarm uses metric math to calculate `100 * HTTPCode_Target_5XX_Count / RequestCount` over one-minute periods, and the default threshold is `5%` for `3` consecutive periods. For a small exercise environment, that feels like a reasonable balance between reacting quickly and avoiding noise from one-off failures.

The action publishes to an SNS topic that is created in CDK. I stopped at the topic rather than adding an email subscription because email subscriptions require manual confirmation, which would break the “no manual steps” rule. In a production setup, I would connect the topic to something that can be managed end-to-end in code, such as Chatbot, EventBridge, or a Lambda-based notification bridge.

## What I Would Add Given More Time

If I had more time, I would add ECS auto-scaling, ECR repository provisioning with immutable image promotion by digest, CI/CD around the CDK deployment flow, automated frontend asset deployment, WAF protection for both entry points, VPC endpoints for common AWS dependencies, and a health-aware version of the gradual traffic-shift flow so the system can pause or abort automatically when alarms or target health go bad.
