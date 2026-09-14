// AT9 (ROAD-144). What a provider exchange has to hand back for the
// backend to resolve or create a users row. Both OAuth providers reduce to
// this; the magic link produces the same shape with provider 'email'.

export type ProviderIdentity = {
  provider: 'github' | 'google';
  // The provider's stable subject id — users.authProviderId.
  providerId: string;
  email: string;
  // Whether the provider vouched for the email. GitHub: the primary email
  // flagged verified; Google: email_verified in the userinfo claim. An
  // unverified email still signs in, but does not set emailVerifiedAt.
  emailVerified: boolean;
  fullName: string;
  avatarUrl: string | null;
};

// Injected so tests never hit github.com / google.com and so the exchange
// is testable with recorded shapes rather than live credentials.
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type OAuthProvider = {
  name: 'github' | 'google';
  authorizeUrl(args: { clientId: string; redirectUri: string; state: string }): string;
  exchange(
    args: { clientId: string; clientSecret: string; redirectUri: string; code: string },
    fetch: FetchLike,
  ): Promise<ProviderIdentity>;
};

export class ProviderExchangeError extends Error {
  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderExchangeError';
  }
}
