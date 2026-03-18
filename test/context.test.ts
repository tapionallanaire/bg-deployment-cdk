import { resolveContext } from '../lib/config/context';
import { createTestApp, TEST_ENV } from './helpers/test-app';

describe('resolveContext', () => {
  it('throws when CDK_DEFAULT_ACCOUNT is missing', () => {
    const app = createTestApp();

    expect(() =>
      resolveContext(app.node, {
        region: TEST_ENV.region,
      }),
    ).toThrow('CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION must be set.');
  });

  it('throws when CDK_DEFAULT_REGION is missing', () => {
    const app = createTestApp();

    expect(() =>
      resolveContext(app.node, {
        account: TEST_ENV.account,
      }),
    ).toThrow('CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION must be set.');
  });

  it('throws for an invalid ecsImageSource value', () => {
    const app = createTestApp({
      ecsImageSource: 'tarball',
    });

    expect(() => resolveContext(app.node, TEST_ENV)).toThrow(
      `ecsImageSource must be 'asset' or 'registry', got: "tarball"`,
    );
  });

  it('throws when traffic weights do not add up to 100', () => {
    const app = createTestApp({
      blueTrafficWeight: 80,
      greenTrafficWeight: 10,
    });

    expect(() => resolveContext(app.node, TEST_ENV)).toThrow(
      'blueTrafficWeight (80) + greenTrafficWeight (10) must equal 100.',
    );
  });

  it('returns the typed image source after validation', () => {
    const app = createTestApp({
      ecsImageSource: 'registry',
    });

    const ctx = resolveContext(app.node, TEST_ENV);

    expect(ctx.ecsImageSource).toBe('registry');
  });
});
