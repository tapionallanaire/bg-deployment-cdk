#!/usr/bin/env ts-node
/**
 * Gradual traffic shift script — bonus feature.
 *
 * Drives repeated `cdk deploy` operations with updated Route 53 weights so
 * traffic shifts remain fully managed by CloudFormation. This avoids the drift
 * caused by mutating ALBs or Route 53 records directly via SDK calls.
 *
 * Usage:
 *   npx ts-node scripts/shift-traffic.ts \
 *     --stack-name my-app-dev-backend \
 *     --start-green-weight 0 \
 *     --target-green-weight 100 \
 *     [--step 10] \
 *     [--interval-seconds 120] \
 *     [--dry-run]
 */

import { spawnSync } from 'node:child_process';

interface CliArgs {
  stackName: string;
  startGreenWeight: number;
  targetGreenWeight: number;
  step: number;
  intervalSeconds: number;
  dryRun: boolean;
}

function parsePercent(value: string | undefined, flagName: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${flagName} must be an integer between 0 and 100`);
  }

  return parsed;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  // Keep argument parsing intentionally simple because the script only supports
  // a small fixed set of flags and is meant to stay easy to audit.
  function flag(name: string): string | undefined {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  const stackName = flag('stack-name');
  const startGreenWeight = flag('start-green-weight');
  const targetGreenWeight = flag('target-green-weight');

  if (!stackName || !startGreenWeight || !targetGreenWeight) {
    throw new Error(
      'Usage: shift-traffic.ts --stack-name <backend-stack> --start-green-weight <0-100> --target-green-weight <0-100> [--step 10] [--interval-seconds 120] [--dry-run]',
    );
  }

  return {
    stackName,
    startGreenWeight: parsePercent(startGreenWeight, '--start-green-weight'),
    targetGreenWeight: parsePercent(targetGreenWeight, '--target-green-weight'),
    step: parsePercent(flag('step') ?? '10', '--step'),
    intervalSeconds: Number(flag('interval-seconds') ?? '120'),
    dryRun: args.includes('--dry-run'),
  };
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function deployWeights(args: CliArgs, greenWeight: number): void {
  const blueWeight = 100 - greenWeight;
  // Every shift is just another backend deploy with new context values.
  // That keeps the source of truth in CDK and avoids configuration drift.
  const command = [
    'cdk',
    'deploy',
    args.stackName,
    '--require-approval',
    'never',
    '--context',
    `blueTrafficWeight=${blueWeight}`,
    '--context',
    `greenTrafficWeight=${greenWeight}`,
  ];

  console.log(
    `${args.dryRun ? '[DRY RUN] ' : ''}Deploying weights → blue: ${blueWeight}, green: ${greenWeight}`,
  );

  if (args.dryRun) {
    console.log(`npx ${command.join(' ')}`);
    return;
  }

  const result = spawnSync('npx', command, {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`cdk deploy failed with exit code ${result.status ?? 'unknown'}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.intervalSeconds < 0 || !Number.isInteger(args.intervalSeconds)) {
    throw new Error('--interval-seconds must be a non-negative integer');
  }

  if (args.step === 0) {
    throw new Error('--step must be greater than 0');
  }

  console.log(`Start green weight: ${args.startGreenWeight}`);
  console.log(`Target green weight: ${args.targetGreenWeight}`);
  console.log(`Step:               ${args.step}%`);
  console.log(`Interval:           ${args.intervalSeconds}s`);

  if (args.startGreenWeight === args.targetGreenWeight) {
    console.log('Already at target weight. Nothing to do.');
    return;
  }

  const direction = args.startGreenWeight < args.targetGreenWeight ? 1 : -1;
  let currentGreenWeight = args.startGreenWeight;

  // Walk green traffic toward the target in fixed increments. After each deploy
  // the script pauses so the operator can check alarms and target health before
  // continuing to the next step.
  while (currentGreenWeight !== args.targetGreenWeight) {
    const nextWeight =
      direction > 0
        ? Math.min(currentGreenWeight + args.step, args.targetGreenWeight)
        : Math.max(currentGreenWeight - args.step, args.targetGreenWeight);

    deployWeights(args, nextWeight);
    currentGreenWeight = nextWeight;

    if (currentGreenWeight !== args.targetGreenWeight) {
      console.log(
        `Waiting ${args.intervalSeconds}s before the next deploy. Review alarms and target health now.`,
      );
      await sleep(args.intervalSeconds);
    }
  }

  console.log(`Traffic shift complete. Green is now at ${args.targetGreenWeight}%.`);
}

main().catch((err: Error) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
