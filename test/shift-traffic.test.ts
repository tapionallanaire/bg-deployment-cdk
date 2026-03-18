import { buildDeployCommand, main, parseArgsFrom, parsePercent } from '../scripts/shift-traffic';

describe('shift-traffic script', () => {
  it('parses required flags and default values', () => {
    const args = parseArgsFrom([
      '--stack-name',
      'bg-app-dev-backend',
      '--start-green-weight',
      '10',
      '--target-green-weight',
      '100',
    ]);

    expect(args).toEqual({
      stackName: 'bg-app-dev-backend',
      startGreenWeight: 10,
      targetGreenWeight: 100,
      step: 10,
      intervalSeconds: 120,
      dryRun: false,
    });
  });

  it('builds the expected cdk deploy command for a weight change', () => {
    const command = buildDeployCommand(
      {
        stackName: 'bg-app-dev-backend',
        startGreenWeight: 0,
        targetGreenWeight: 100,
        step: 10,
        intervalSeconds: 120,
        dryRun: false,
      },
      30,
    );

    expect(command).toEqual([
      'cdk',
      'deploy',
      'bg-app-dev-backend',
      '--require-approval',
      'never',
      '--context',
      'blueTrafficWeight=70',
      '--context',
      'greenTrafficWeight=30',
    ]);
  });

  it('rejects invalid percent values', () => {
    expect(() => parsePercent('110', '--step')).toThrow(
      '--step must be an integer between 0 and 100',
    );
  });

  it('fails fast when step is zero', async () => {
    await expect(
      main([
        '--stack-name',
        'bg-app-dev-backend',
        '--start-green-weight',
        '0',
        '--target-green-weight',
        '100',
        '--step',
        '0',
      ]),
    ).rejects.toThrow('--step must be greater than 0');
  });
});
