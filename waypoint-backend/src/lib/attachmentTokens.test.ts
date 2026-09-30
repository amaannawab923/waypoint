import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_TOKEN_TTL_MS,
  mintAttachmentToken,
  verifyAttachmentToken,
} from './attachmentTokens.js';

describe('attachment URL tokens', () => {
  it('accepts a token it just minted for that id', () => {
    const token = mintAttachmentToken('att-1');
    expect(verifyAttachmentToken('att-1', token)).toBe(true);
  });

  it('refuses a token minted for a different attachment', () => {
    // The whole point: a signature is a capability for ONE file, not proof
    // of being signed in.
    const token = mintAttachmentToken('att-1');
    expect(verifyAttachmentToken('att-2', token)).toBe(false);
  });

  it('refuses a token past its expiry', () => {
    const now = Date.now();
    const token = mintAttachmentToken('att-1', now);
    expect(verifyAttachmentToken('att-1', token, now + ATTACHMENT_TOKEN_TTL_MS - 1)).toBe(true);
    expect(verifyAttachmentToken('att-1', token, now + ATTACHMENT_TOKEN_TTL_MS + 1)).toBe(false);
  });

  it('refuses a token whose expiry was edited to extend it', () => {
    // The expiry travels inside the token, so it is attacker-controlled
    // until the HMAC says otherwise — this is the case that would pass if
    // expiry were checked before the signature.
    const now = Date.now();
    const token = mintAttachmentToken('att-1', now);
    const signature = token.slice(token.indexOf('.') + 1);
    const forged = `${now + 10 * ATTACHMENT_TOKEN_TTL_MS}.${signature}`;
    expect(verifyAttachmentToken('att-1', forged, now)).toBe(false);
  });

  it('refuses malformed, empty, and non-string tokens without throwing', () => {
    for (const bad of ['', '.', 'nope', 'abc.def', '123', `${Date.now()}.`]) {
      expect(verifyAttachmentToken('att-1', bad)).toBe(false);
    }
    expect(verifyAttachmentToken('att-1', undefined)).toBe(false);
    expect(verifyAttachmentToken('att-1', null)).toBe(false);
    // Express gives `req.query.t` as an array when `?t=a&t=b` is sent.
    expect(verifyAttachmentToken('att-1', ['a', 'b'] as unknown)).toBe(false);
  });

  it('does not confuse an id/expiry pair with a differently-split one', () => {
    // Without a separator, ("a", 1123) and ("a1", 123) would sign the same
    // bytes and each token would verify for the other's attachment.
    const now = 123;
    const a = mintAttachmentToken('a', now);
    expect(verifyAttachmentToken('a1', a, now)).toBe(false);
  });
});
