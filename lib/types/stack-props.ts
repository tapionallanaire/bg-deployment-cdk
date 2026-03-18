import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AppContext } from '../config/context';

export interface NetworkStackProps extends cdk.StackProps {
  readonly ctx: AppContext;
}

export interface BackendStackProps extends cdk.StackProps {
  readonly ctx: AppContext;
  /** VPC created by NetworkStack. */
  readonly vpc: ec2.IVpc;
  /** Security group for the ALB — allows inbound 80/443 from the internet. */
  readonly albSecurityGroup: ec2.ISecurityGroup;
  /** Security group for ECS tasks — allows inbound only from the ALB SG. */
  readonly ecsSecurityGroup: ec2.ISecurityGroup;
  /** S3 bucket receiving ALB access logs, created in NetworkStack. */
  readonly albLogBucket: s3.IBucket;
}

export interface FrontendStackProps extends cdk.StackProps {
  readonly ctx: AppContext;
}
