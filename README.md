# Blue/Green Deployment Pipeline — AWS CDK (TypeScript)

I built this repository as a small but fully automated blue/green deployment setup in AWS CDK. The backend runs on ECS Fargate, the frontend is served from S3 through CloudFront, and the whole point of the design is that nothing depends on clicking around in the AWS console. If I need to change traffic, capacity, or a deployment version, I want that change to live in CDK context and be applied with `cdk deploy`.

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

If I want a simple local shell setup, I can copy `.env.example` to `.env` and source it before running AWS or CDK commands. I kept this optional and documented it clearly because the project does not auto-load `.env`.

The repository already includes a working default context in `cdk.json`, so the checked-in stack names are `bg-app-dev-network`, `bg-app-dev-backend`, and `bg-app-dev-frontend`. In this project, stack names always follow the pattern `<appName>-<environment>-<stack>`. If I change `appName` or `environment`, I also need to change the commands below to match, and `cdk ls` is the quickest way to confirm the exact names.

If I want to customize the deployment, the most important context values are the application name, the environment name, and the blue and green images. If I want the full Route 53 weighted backend routing flow, I also set the hosted zone values and backend hostname. That path is implemented in CDK, but it only becomes testable when a real hosted zone and backend hostname are available in the target account.

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

If I want HTTPS on the backend, I also set `certificateArn`. If I want a frontend custom domain, I set `customDomainName`, `frontendCertificateArn`, `frontendHostedZoneId`, and `frontendHostedZoneName`. If I am treating the environment as persistent rather than disposable, I set `removalPolicy` to `RETAIN`.

Before deploying anything, I run the tests. These are CDK assertion tests, so they do not deploy resources or call AWS APIs.

```bash
npm test
```

Then I synthesize the stacks locally so I can review the generated templates.

```bash
cdk synth
cdk ls
```

Once that looks right, I deploy either everything or each stack individually.

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

Once green is healthy, I can cut traffic over completely.

```bash
cdk deploy bg-app-dev-backend \
  --context blueTrafficWeight=0 \
  --context greenTrafficWeight=100
```

That cutover only affects traffic that arrives through the shared Route 53 record. If I test the blue or green ALB DNS names directly, I will still hit those ALBs directly, which is expected. In the exercise account I used for this submission, I validated the blue and green ALBs independently, but I did not validate Route 53 cutover end to end because I did not have a hosted zone and backend hostname available.

If I want to scale blue down after the new version has had time to soak, I do that with another backend deploy.

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

## Architecture Overview

At a high level, the backend has two independent paths, one for blue and one for green. Route 53 sits in front and decides how much traffic goes to each path by using weighted alias records. Each color has its own ALB, its own target group, and its own ECS service. That costs a little more than sharing a single ALB, but it makes the blue/green story much cleaner because each color is a real standalone endpoint. Both ALBs send their access logs to an S3 bucket, and each ALB has its own CloudWatch 5xx rate alarm wired to SNS so unhealthy behavior is visible per color instead of being mixed together. The ECS tasks live in private subnets and use VPC endpoints for ECR, S3, and CloudWatch Logs so I do not have to leave `0.0.0.0/0` egress open on the private task security group. The frontend is separate from all of that. Static files go into a private S3 bucket, CloudFront reads from it through Origin Access Control, and if a domain is available it can be attached through Route 53 and ACM.

## Architecture Decisions

The main architecture decision I made was to optimize for clarity and rollback safety over the absolute cheapest possible design. The details below are the choices that shaped the final structure.

I split the stacks by how I expect them to change. The network stack owns the VPC, the subnets, the NAT gateway, the shared security groups, and the ALB log bucket because those resources feel foundational and change less often. The backend stack owns the ECS cluster, both deployment colors, the two ALBs, the Route 53 weighted records, and the backend alarms because that is the part I expect to redeploy while iterating on application releases. The frontend stack is separate because I do not want a frontend change to have any chance of disturbing the backend deployment path.

The biggest design choice was using two ALBs. If this were purely an optimization exercise, I probably would have used one ALB with weighted forwarding and saved some cost. I did not do that here because the brief explicitly calls for Route 53 weighted routing records. To make Route 53 weighting meaningful, blue and green need to be distinct endpoints, so I gave each color its own ALB.

I also kept the images separate on purpose. Blue uses `ecsBlueContainerImage` and green uses `ecsGreenContainerImage`. That sounds simple, but it matters. A rollback only feels real if blue can continue serving the old version while green is tested with the new one. If both colors always point to the same image, the deployment may look blue/green on paper but it is not really giving you rollback safety.

I decided not to use CodeDeploy ECS blue/green for this exercise. CodeDeploy is a valid production choice, but it hides part of the traffic-shift logic behind the service itself. For a take-home, I thought it was better to keep the mechanism explicit and easy to review in code, so Route 53 weights plus CDK context felt like the clearest solution.

I also tightened the private networking so the ECS tasks do not need open internet egress. Instead of pulling their runtime image directly from a public registry, CDK builds the backend as a Docker asset and publishes it to private ECR during deployment. Inside the VPC, the tasks reach ECR, S3, and CloudWatch Logs through VPC endpoints, which keeps the private security group scoped to VPC-local HTTPS and DNS only.

## Blue/Green Mechanism

Traffic shifting is controlled by two Route 53 weighted alias records that share the same record name. If blue has weight `100` and green has weight `0`, all traffic goes to blue. If they are both `50`, traffic is split evenly. If green is `100`, then green is fully live. Those weights come directly from CDK context, so shifting traffic is just a backend deploy with different values.

In practice, the deployment flow is simple. I first deploy the new version to green while blue still carries all production traffic. Once green is healthy and looks good, I start moving traffic over. If I want to be careful, I do that in stages. If I am confident, I cut over all at once. Blue stays there as an immediate fallback until I decide it is safe to scale it down.

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

There are a few things I intentionally left out. I did not deploy custom domains or make backend HTTPS mandatory because I do not have a domain and matching ACM certificates available for this account, and the frontend path would also require a certificate in `us-east-1`. The backend Route 53 weighted-routing path is implemented in CDK, but I did not validate it end to end in this account because I do not have a hosted zone and backend hostname available for the exercise. I did validate the blue and green ALBs directly and verified the backend services independently. I also hit an AWS account verification restriction when creating a CloudFront distribution in this account. The frontend stack is implemented in CDK, but waiting for AWS to complete account verification was outside the four-hour exercise budget, so I could not fully validate the frontend deployment path in this account. I also left out CI/CD and ECS auto-scaling so I could keep the time budget focused on the core infrastructure and make the blue/green flow easier to demonstrate. The gradual traffic-shift script still requires operator judgment between steps, but all traffic changes remain CDK-driven and do not require manual console changes.

## Doubts

One assumption I made was that blue/green applies to the backend only. My reading of the brief was that the weighted traffic-shift requirement is tied to the ALB in front of ECS, while the frontend is a separate static site served from S3 through CloudFront. I documented that assumption here rather than stretching the frontend into a second blue/green system that the brief did not clearly ask for.

## Removal Policy Decisions

The ALB log bucket and the frontend assets bucket both follow the shared `removalPolicy` context. In a throwaway dev environment, I prefer `DESTROY` because it keeps cleanup easy and avoids paying to retain low-value data. In a longer-lived environment, I would switch those buckets to `RETAIN` because access logs are useful operational history and frontend objects may still be referenced by cached content. The ECS CloudWatch log groups are always retained. I made that choice because log retention already controls storage cost, and I would rather keep the log groups around than lose the evidence of why a deployment failed.

## Context Reference

The most important context values are `appName` and `environment`, which drive naming across the stacks. `ecsBlueContainerImage` and `ecsGreenContainerImage` define the base images for each color. The default `ecsImageSource` is `asset`, which means CDK builds and publishes a private ECR image during deployment. There is also a `registry` mode, mainly to keep unit tests simple and offline. The older `ecsContainerImage` key is still accepted as a fallback for blue so the project stays backward compatible. `ecsBlueDesiredCount` and `ecsGreenDesiredCount` control how many tasks each color runs. `blueTrafficWeight` and `greenTrafficWeight` control the Route 53 split. `hostedZoneId`, `hostedZoneName`, and `albDomainName` are what make the backend weighted routing possible. `certificateArn` enables HTTPS on the backend ALBs. `logRetentionDays`, `albLogRetentionDays`, and `alarm5xxRateThresholdPercent` control the main observability defaults. `removalPolicy` controls whether stateful S3 buckets are destroyed or retained. The remaining frontend-specific values are `cloudFrontPriceClass`, `customDomainName`, `frontendCertificateArn`, `frontendHostedZoneId`, and `frontendHostedZoneName`.

## CloudWatch Alarm Justification

Each ALB gets its own 5xx rate alarm. I deliberately used a rate rather than a raw error count because a fixed count gets less meaningful as traffic changes. The alarm uses metric math to calculate `100 * HTTPCode_Target_5XX_Count / RequestCount` over one-minute periods, and the default threshold is `5%` for `3` consecutive periods. For a small exercise environment, that feels like a reasonable balance between reacting quickly and avoiding noise from one-off failures.

The action publishes to an SNS topic that is created in CDK. I stopped at the topic rather than adding an email subscription because email subscriptions require manual confirmation, which would break the “no manual steps” rule. In a production setup, I would connect the topic to something that can be managed end-to-end in code, such as Chatbot, EventBridge, or a Lambda-based notification bridge.

## What I Would Add Given More Time

If I had more time, I would add ECS auto-scaling, ECR repository provisioning with immutable image promotion by digest, CI/CD around the CDK deployment flow, automated frontend asset deployment, WAF protection for both entry points, VPC endpoints for common AWS dependencies, and a health-aware version of the gradual traffic-shift flow so the system can pause or abort automatically when alarms or target health go bad.
