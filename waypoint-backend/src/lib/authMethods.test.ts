import { describe, it, expect } from 'vitest';
import { configuredAuthMethods } from './authMethods.js';

describe('configuredAuthMethods', () => {
  it('is empty when nothing is set', () => {
    expect(configuredAuthMethods({})).toEqual([]);
  });

  it('needs both halves of an OAuth pair', () => {
    expect(configuredAuthMethods({ GITHUB_OAUTH_CLIENT_ID: 'id' })).toEqual([]);
    expect(configuredAuthMethods({ GITHUB_OAUTH_CLIENT_ID: 'id', GITHUB_OAUTH_CLIENT_SECRET: 's' })).toEqual(['github']);
  });

  it('treats a blank value as unset, like CORS_ORIGIN', () => {
    expect(configuredAuthMethods({ SMTP_HOST: '  ', SMTP_FROM: 'a@b' })).toEqual([]);
  });

  it('returns methods in a stable order regardless of env order', () => {
    expect(
      configuredAuthMethods({
        SMTP_FROM: 'a@b',
        SMTP_HOST: 'mail',
        GOOGLE_OAUTH_CLIENT_SECRET: 's',
        GOOGLE_OAUTH_CLIENT_ID: 'id',
        GITHUB_OAUTH_CLIENT_SECRET: 's',
        GITHUB_OAUTH_CLIENT_ID: 'id',
      }),
    ).toEqual(['github', 'google', 'email']);
  });
});
