import {
  matchingCommands,
  matchingKeys,
  parseSlash,
  slashCompletionStage,
} from './copilotSlash';

describe('parseSlash', () => {
  it('is not a slash for ordinary text', () => {
    expect(parseSlash('look at ROAD-116')).toEqual({ kind: 'not-slash' });
    expect(parseSlash('')).toEqual({ kind: 'not-slash' });
  });
  it('parses the three commands, upper-casing the key', () => {
    expect(parseSlash('/investigate road-116')).toMatchObject({
      kind: 'command',
      parsed: {
        command: { name: 'investigate', intent: 'investigate' },
        key: 'ROAD-116',
        text: '',
      },
    });
    expect(parseSlash('  /fix ROAD-116 keep the API')).toMatchObject({
      kind: 'command',
      parsed: {
        command: { name: 'fix' },
        key: 'ROAD-116',
        text: 'keep the API',
      },
    });
    expect(
      parseSlash('/session ROAD-116 list every IPC channel'),
    ).toMatchObject({
      kind: 'command',
      parsed: {
        command: { intent: 'custom' },
        key: 'ROAD-116',
        text: 'list every IPC channel',
      },
    });
  });
  it.each([
    ['/', 'Pick a command'],
    ['/deploy ROAD-1', 'No command /deploy'],
    ['/fix', 'Add the ticket key (ROAD-116)'],
    ['/fix nope', 'nope is not a ticket key'],
    ['/session ROAD-116', 'Say what the session should do'],
  ])('%s is incomplete: %s', (input, reason) => {
    expect(parseSlash(input)).toMatchObject({ kind: 'incomplete', reason });
  });
});

describe('completion', () => {
  it('matches commands by prefix, case-insensitively', () => {
    expect(matchingCommands('').map((c) => c.name)).toEqual([
      'investigate',
      'fix',
      'session',
    ]);
    expect(matchingCommands('F').map((c) => c.name)).toEqual(['fix']);
    expect(matchingCommands('x')).toEqual([]);
  });
  it('matches keys by prefix, bounded', () => {
    const tickets = [
      { identifier: 'ROAD-116', title: 'a' },
      { identifier: 'ROAD-117', title: 'b' },
      { identifier: 'ENG-1', title: 'c' },
    ];
    expect(matchingKeys('road-11', tickets).map((t) => t.identifier)).toEqual([
      'ROAD-116',
      'ROAD-117',
    ]);
    expect(matchingKeys('', tickets, 2)).toHaveLength(2);
  });
  it('knows which part is being completed', () => {
    expect(slashCompletionStage('/inv')).toEqual({
      stage: 'command',
      typed: 'inv',
    });
    expect(slashCompletionStage('/fix RO')).toEqual({
      stage: 'key',
      typed: 'RO',
    });
    expect(slashCompletionStage('/fix ROAD-116 note')).toBeNull();
    expect(slashCompletionStage('hello')).toBeNull();
  });
});
