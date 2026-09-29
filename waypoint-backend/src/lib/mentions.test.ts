import { describe, expect, it } from 'vitest';
import { findMentionedMemberIds } from './mentions.js';

const PRIYA = { id: 'm-priya', displayName: 'Priya' };
const AMAAN = { id: 'm-amaan', displayName: 'Amaan' };
const AMAAN_NAWAB = { id: 'm-amaan-nawab', displayName: 'Amaan Nawab' };
const MEMBERS = [PRIYA, AMAAN, AMAAN_NAWAB];

describe('findMentionedMemberIds', () => {
  it('finds a single-word name', () => {
    expect(findMentionedMemberIds('thanks @Priya, looks right', MEMBERS)).toEqual(['m-priya']);
  });

  it('finds a name with a space, which no pattern-based parser could delimit', () => {
    expect(findMentionedMemberIds('@Amaan Nawab can you check', MEMBERS)).toEqual(['m-amaan-nawab']);
  });

  it('prefers the longest name and does not also notify its prefix', () => {
    // "Amaan" is a prefix of "Amaan Nawab"; only the full name was meant.
    expect(findMentionedMemberIds('cc @Amaan Nawab', MEMBERS)).toEqual(['m-amaan-nawab']);
  });

  it('still finds the shorter name when it is used on its own', () => {
    expect(findMentionedMemberIds('@Amaan and @Amaan Nawab', MEMBERS).sort()).toEqual(
      ['m-amaan', 'm-amaan-nawab'].sort(),
    );
  });

  it('ignores an email-shaped string, where "@" follows a word character', () => {
    expect(findMentionedMemberIds('mail bob@Priya.dev', MEMBERS)).toEqual([]);
  });

  it('does not match a name that merely starts with a member name', () => {
    expect(findMentionedMemberIds('@Priyanka owns this', MEMBERS)).toEqual([]);
  });

  it('is case-insensitive, since hand-typed mentions are not always capitalised', () => {
    expect(findMentionedMemberIds('@priya ?', MEMBERS)).toEqual(['m-priya']);
  });

  it('accepts a mention at the very start, after a newline, or inside brackets', () => {
    expect(findMentionedMemberIds('@Priya', MEMBERS)).toEqual(['m-priya']);
    expect(findMentionedMemberIds('line one\n@Priya', MEMBERS)).toEqual(['m-priya']);
    expect(findMentionedMemberIds('(@Priya)', MEMBERS)).toEqual(['m-priya']);
  });

  it('reports each member once however many times they are mentioned', () => {
    expect(findMentionedMemberIds('@Priya @Priya @Priya', MEMBERS)).toEqual(['m-priya']);
  });

  it('treats regex metacharacters in a display name literally', () => {
    const odd = { id: 'm-odd', displayName: 'J.R. (Ops)' };
    expect(findMentionedMemberIds('ping @J.R. (Ops) now', [odd])).toEqual(['m-odd']);
    expect(findMentionedMemberIds('ping @JxR. (Ops) now', [odd])).toEqual([]);
  });

  it('never matches a member with an empty display name', () => {
    expect(findMentionedMemberIds('@ hello', [{ id: 'm-blank', displayName: '  ' }])).toEqual([]);
  });
});
