# Blue/Green Deployment Pipeline — AWS CDK (TypeScript)

I built this repository as a small but fully automated blue/green deployment setup in AWS CDK. The backend runs on ECS Fargate, the frontend is served from S3 through CloudFront, and the whole point of the design is that nothing depends on clicking around in the AWS console. If I need to change traffic, capacity, or a deployment version, I want that change to live in CDK context and be applied with `cdk deploy`.

## Architecture Overview

At a high level, the backend has two independent paths, one for blue and one for green. Route 53 sits in front and decides how much traffic goes to each path by using weighted alias records. Each color has its own ALB, its own target group, and its own ECS service. That costs a little more than sharing a single ALB, but it makes the blue/green story much cleaner because each color is a real standalone endpoint. Both ALBs send their access logs to an S3 bucket, and each ALB has its own CloudWatch 5xx rate alarm wired to SNS so unhealthy behavior is visible per color instead of being mixed together. The frontend is separate from all of that. Static files go into a private S3 bucket, CloudFront reads from it through Origin Access Control, and if a domain is available it can be attached through Route 53 and ACM.

## Architecture Decision

The main architecture decision I made was to optimize for clarity and rollback safety over the absolute cheapest possible design. The details below are the choices that shaped the final structure.

I split the stacks by how I expect them to change. The network stack owns the VPC, the subnets, the NAT gateway, the shared security groups, and the ALB log bucket because those resources feel foundational and change less often. The backend stack owns the ECS cluster, both deployment colors, the two ALBs, the Route 53 weighted records, and the backend alarms because that is the part I expect to redeploy while iterating on application releases. The frontend stack is separate because I do not want a frontend change to have any chance of disturbing the backend deployment path.

The biggest design choice was using two ALBs. If this were purely an optimization exercise, I probably would have used one ALB with weighted forwarding and saved some cost. I did not do that here because the brief explicitly calls for Route 53 weighted routing records. To make Route 53 weighting meaningful, blue and green need to be distinct endpoints, so I gave each color its own ALB.

I also kept the images separate on purpose. Blue uses `ecsBlueContainerImage` and green uses `ecsGreenContainerImage`. That sounds simple, but it matters. A rollback only feels real if blue can continue serving the old version while green is tested with the new one. If both colors always point to the same image, the deployment may look blue/green on paper but it is not really giving you rollback safety.

I decided not to use CodeDeploy ECS blue/green for this exercise. CodeDeploy is a valid production choice, but it hides part of the traffic-shift logic behind the service itself. For a take-home, I thought it was better to keep the mechanism explicit and easy to review in code, so Route 53 weights plus CDK context felt like the clearest solution.

## Blue/Green Mechanism

Traffic shifting is controlled by two Route 53 weighted alias records that share the same record name. If blue has weight `100` and green has weight `0`, all traffic goes to blue. If they are both `50`, traffic is split evenly. If green is `100`, then green is fully live. Those weights come directly from CDK context, so shifting traffic is just a backend deploy with different values.

In practice, the deployment flow is simple. I first deploy the new version to green while blue still carries all production traffic. Once green is healthy and looks good, I start moving traffic over. If I want to be careful, I do that in stages. If I am confident, I cut over all at once. Blue stays there as an immediate fallback until I decide it is safe to scale it down.

If blue is still running, rollback is just restoring the weights to `100/0`.

```bash
cdk deploy my-app-dev-backend \
  --context blueTrafficWeight=100 \
  --context greenTrafficWeight=0
```

If I already scaled blue down, then rollback is still one deploy, but I also bring blue capacity back in the same change.

```bash
cdk deploy my-app-dev-backend \
  --context ecsBlueDesiredCount=1 \
  --context blueTrafficWeight=100 \
  --context greenTrafficWeight=0
```

That is the main reason I like this setup for the exercise. The rollback story is boring, and boring is what I want from infrastructure during an incident.

## What Is Not Implemented

There are a few things I intentionally left out. Backend HTTPS is supported through `certificateArn`, but I did not make it mandatory because not every exercise account has a domain and certificate ready to use. The frontend custom-domain path is also implemented but not enabled by default for the same reason, except there the certificate also has to exist in `us-east-1`. I did not deploy a custom domain for either backend or frontend because I do not have a domain and matching ACM certificates available for this exercise account. I did not build a CI pipeline because I wanted to spend the time budget on the actual infrastructure and on explaining my decisions clearly. I also left out ECS auto-scaling because fixed desired counts make the blue/green flow much easier to demonstrate and reason about in a take-home. Finally, the gradual traffic-shift script still expects the operator to watch health and alarms between steps rather than automating that decision.

## How to Deploy from Scratch

The setup assumes the AWS CLI is configured, Node.js 18 or newer is installed, and CDK v2 is available globally. The account and region also need to be bootstrapped first.

```bash
cdk bootstrap aws://<account-id>/<region>
```

After that, clone the repository and install dependencies.

```bash
git clone <repo>
cd bg-deployment-cdk
npm install
```

The next step is to set the CDK context. The minimum useful configuration is the application name, the environment name, the blue and green images, and the Route 53 zone values that allow weighted backend routing.

```json
{
  "context": {
    "appName": "my-app",
    "environment": "dev",
    "ecsBlueContainerImage": "public.ecr.aws/docker/library/nginx:1.27-alpine",
    "ecsGreenContainerImage": "public.ecr.aws/docker/library/nginx:1.28-alpine",
    "hostedZoneId": "Z123EXAMPLE",
    "hostedZoneName": "example.com",
    "albDomainName": "api.example.com"
  }
}
```

If I want HTTPS on the backend, I also set `certificateArn`. If I want a frontend custom domain, I set `customDomainName`, `frontendCertificateArn`, `frontendHostedZoneId`, and `frontendHostedZoneName`. If I am treating the environment as persistent rather than disposable, I set `removalPolicy` to `RETAIN`.

Before deploying anything, I run the tests. These are CDK assertion tests, so they do not deploy resources or call AWS APIs.

```bash
npm test
```

Then I synthesize the stacks locally so I can review the generated templates.

```bash
cdk synth
```

Once that looks right, I deploy either everything or each stack individually.

```bash
CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text) \
CDK_DEFAULT_REGION=$(aws configure get region) \
cdk deploy --all
```

```bash
cdk deploy my-app-dev-network
cdk deploy my-app-dev-backend
cdk deploy my-app-dev-frontend
```

After the frontend stack exists, I still need to upload the built static assets and invalidate CloudFront.

```bash
aws s3 sync ./dist s3://$(aws cloudformation describe-stacks \
  --stack-name my-app-dev-frontend \
  --query "Stacks[0].Outputs[?OutputKey=='FrontendBucket'].OutputValue" \
  --output text)/
```

```bash
aws cloudfront create-invalidation \
  --distribution-id $(aws cloudformation describe-stacks \
    --stack-name my-app-dev-frontend \
    --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" \
    --output text) \
  --paths "/*"
```

## How to Switch from Blue to Green

The safest sequence is to deploy the new version onto green first while blue still receives all production traffic.

```bash
cdk deploy my-app-dev-backend \
  --context ecsGreenContainerImage=public.ecr.aws/docker/library/nginx:1.28-alpine \
  --context ecsGreenDesiredCount=1 \
  --context blueTrafficWeight=100 \
  --context greenTrafficWeight=0
```

Once green is healthy, I can cut traffic over completely.

```bash
cdk deploy my-app-dev-backend \
  --context blueTrafficWeight=0 \
  --context greenTrafficWeight=100
```

If I want to scale blue down after the new version has had time to soak, I do that with another backend deploy.

```bash
cdk deploy my-app-dev-backend \
  --context ecsBlueDesiredCount=0 \
  --context blueTrafficWeight=0 \
  --context greenTrafficWeight=100
```

For a more cautious rollout, the bonus script performs repeated `cdk deploy` calls with stepped Route 53 weights, so the state stays inside CloudFormation instead of drifting through direct AWS API changes.

```bash
npx ts-node scripts/shift-traffic.ts \
  --stack-name my-app-dev-backend \
  --start-green-weight 0 \
  --target-green-weight 100 \
  --step 10 \
  --interval-seconds 120
```

## Removal Policy Decisions

The ALB log bucket and the frontend assets bucket both follow the shared `removalPolicy` context. In a throwaway dev environment, I prefer `DESTROY` because it keeps cleanup easy and avoids paying to retain low-value data. In a longer-lived environment, I would switch those buckets to `RETAIN` because access logs are useful operational history and frontend objects may still be referenced by cached content. The ECS CloudWatch log groups are always retained. I made that choice because log retention already controls storage cost, and I would rather keep the log groups around than lose the evidence of why a deployment failed.

## Context Reference

The most important context values are `appName` and `environment`, which drive naming across the stacks. `ecsBlueContainerImage` and `ecsGreenContainerImage` define the versions for each color. The older `ecsContainerImage` key is still accepted as a fallback for blue so the project stays backward compatible. `ecsBlueDesiredCount` and `ecsGreenDesiredCount` control how many tasks each color runs. `blueTrafficWeight` and `greenTrafficWeight` control the Route 53 split. `hostedZoneId`, `hostedZoneName`, and `albDomainName` are what make the backend weighted routing possible. `certificateArn` enables HTTPS on the backend ALBs. `logRetentionDays`, `albLogRetentionDays`, and `alarm5xxRateThresholdPercent` control the main observability defaults. `removalPolicy` controls whether stateful S3 buckets are destroyed or retained. The remaining frontend-specific values are `cloudFrontPriceClass`, `customDomainName`, `frontendCertificateArn`, `frontendHostedZoneId`, and `frontendHostedZoneName`.

## CloudWatch Alarm Justification

Each ALB gets its own 5xx rate alarm. I deliberately used a rate rather than a raw error count because a fixed count gets less meaningful as traffic changes. The alarm uses metric math to calculate `100 * HTTPCode_Target_5XX_Count / RequestCount` over one-minute periods, and the default threshold is `5%` for `3` consecutive periods. For a small exercise environment, that feels like a reasonable balance between reacting quickly and avoiding noise from one-off failures.

The action publishes to an SNS topic that is created in CDK. I stopped at the topic rather than adding an email subscription because email subscriptions require manual confirmation, which would break the “no manual steps” rule. In a production setup, I would connect the topic to something that can be managed end-to-end in code, such as Chatbot, EventBridge, or a Lambda-based notification bridge.

## What I Would Add Given More Time

If I had more time, I would add ECS auto-scaling, ECR repository provisioning with immutable image promotion by digest, CI/CD around the CDK deployment flow, automated frontend asset deployment, WAF protection for both entry points, VPC endpoints for common AWS dependencies, and a health-aware version of the gradual traffic-shift flow so the system can pause or abort automatically when alarms or target health go bad.
