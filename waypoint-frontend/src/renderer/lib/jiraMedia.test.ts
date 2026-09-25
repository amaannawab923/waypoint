import {
  fitScale,
  isViewable,
  jiraMediaUrl,
  matchMediaToAttachments,
  mediaKindOf,
  mediaSubtitle,
  nextZoom,
} from './jiraMedia';

const att = (over: Partial<Parameters<typeof isViewable>[0]> = {}) => ({
  id: '10037',
  fileName: 'shot.png',
  sizeLabel: '29 KB',
  sizeBytes: 29605,
  mimeType: 'image/png',
  uploaderName: 'Amaan',
  ...over,
});

describe('jiraMediaUrl', () => {
  it('names an id, never a Jira URL', () => {
    expect(jiraMediaUrl('10037')).toBe(
      'waypoint-jira-attachment://attachment/10037',
    );
    expect(jiraMediaUrl('a b')).toBe(
      'waypoint-jira-attachment://attachment/a%20b',
    );
  });
});

describe('mediaKindOf', () => {
  it('reads the kind off the mime type', () => {
    expect(mediaKindOf({ mimeType: 'image/png' })).toBe('image');
    expect(mediaKindOf({ mimeType: 'image/gif' })).toBe('image');
    expect(mediaKindOf({ mimeType: 'IMAGE/WEBP' })).toBe('image');
    expect(mediaKindOf({ mimeType: 'video/mp4' })).toBe('video');
    expect(mediaKindOf({ mimeType: 'audio/mpeg' })).toBe('audio');
    expect(mediaKindOf({ mimeType: 'application/pdf' })).toBe('other');
  });

  it('refuses SVG — an image type that can carry script, from whoever attached it', () => {
    expect(mediaKindOf({ mimeType: 'image/svg+xml' })).toBe('other');
    expect(isViewable(att({ mimeType: 'image/svg+xml' }))).toBe(false);
  });
});

describe('isViewable', () => {
  it('needs both a previewable type and an id to fetch it with', () => {
    expect(isViewable(att())).toBe(true);
    expect(isViewable(att({ id: null }))).toBe(false);
    expect(isViewable(att({ mimeType: 'application/zip' }))).toBe(false);
  });
});

describe('mediaSubtitle', () => {
  it('says the kind and the size, the way Jira does', () => {
    expect(mediaSubtitle(att({ sizeLabel: '435 B' }))).toBe('image · 435 B');
    expect(
      mediaSubtitle(att({ mimeType: 'application/zip', sizeLabel: '2 MB' })),
    ).toBe('file · 2 MB');
  });
});

describe('nextZoom', () => {
  it('steps through the stops and stays inside them', () => {
    expect(nextZoom(1, 1)).toBe(1.5);
    expect(nextZoom(1, -1)).toBe(0.67);
    expect(nextZoom(5, 1)).toBe(5);
    expect(nextZoom(0.1, -1)).toBe(0.1);
  });

  it('steps from an arbitrary fitted scale, not just from a stop', () => {
    // A 4K image opens at ~0.41; + must go to the next stop above it.
    expect(nextZoom(0.41, 1)).toBe(0.5);
    expect(nextZoom(0.41, -1)).toBe(0.33);
  });
});

describe('fitScale', () => {
  it('shrinks a 4K capture to fit, which is how Jira opens it', () => {
    const s = fitScale(
      { width: 3840, height: 2160 },
      { width: 1474, height: 812 },
    );
    expect(Math.round(s * 100)).toBe(38);
  });

  it('never enlarges something already smaller than the viewport', () => {
    expect(
      fitScale({ width: 64, height: 64 }, { width: 1400, height: 800 }),
    ).toBe(1);
  });

  it('is 1 when the image has not reported a size yet', () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 800, height: 600 })).toBe(
      1,
    );
  });
});

describe('matchMediaToAttachments', () => {
  // Taken verbatim from ENG-109 on a live site: the founder pasted the same
  // screenshot twice, so Jira renamed the second attachment by appending
  // its media UUID, and both media nodes kept the SAME alt.
  const ENG109_NODES = [
    {
      id: '6c491db9-67e1-4903-9dd0-aac0756f63f6',
      alt: 'Screenshot 2026-09-23 at 5.40.00 PM.png',
    },
    {
      id: '5907207c-5908-4f5a-8468-2ddeb3803481',
      alt: 'Screenshot 2026-09-23 at 5.40.00 PM.png',
    },
  ];
  const ENG109_ATTACHMENTS = [
    att({ id: '10097', fileName: 'Screenshot 2026-09-23 at 5.40.00 PM.png' }),
    att({
      id: '10098',
      fileName:
        'Screenshot 2026-09-23 at 5.40.00 PM (5907207c-5908-4f5a-8468-2ddeb3803481).png',
    }),
  ];

  it('resolves two nodes sharing one alt to two different attachments', () => {
    const [first, second] = matchMediaToAttachments(
      ENG109_NODES,
      ENG109_ATTACHMENTS,
    );
    // The second node wins its file on the UUID; the first then takes the
    // plain name. Both must NOT be the same attachment.
    expect(second?.id).toBe('10098');
    expect(first?.id).toBe('10097');
  });

  it('matches on the filename when there is no collision rename', () => {
    const out = matchMediaToAttachments(
      [{ id: 'some-uuid', alt: 'dashboard-before.png' }],
      [att({ id: '10038', fileName: 'dashboard-before.png' })],
    );
    expect(out[0]?.id).toBe('10038');
  });

  it('returns null rather than guessing — a wrong image is worse than none', () => {
    const out = matchMediaToAttachments(
      [{ id: 'unknown-uuid', alt: 'not-attached.png' }],
      [att({ id: '10038', fileName: 'dashboard-before.png' })],
    );
    expect(out[0]).toBeNull();
  });

  it('never hands the same attachment to two nodes', () => {
    const one = att({ id: '10038', fileName: 'same.png' });
    const out = matchMediaToAttachments(
      [{ alt: 'same.png' }, { alt: 'same.png' }],
      [one],
    );
    expect(out[0]?.id).toBe('10038');
    expect(out[1]).toBeNull();
  });
});

describe('matchMediaToAttachments, adversarially', () => {
  // `attrs.id` comes out of the issue body: anyone who can edit a
  // description or post a comment chooses it.
  it('ignores a media id that is not a UUID, however suggestive', () => {
    const attachments = [
      att({ id: '10001', fileName: 'unrelated-screenshot.png' }),
      att({ id: '10002', fileName: 'the-real-one.png' }),
    ];
    for (const hostile of ['.', 'png', 'screenshot', '', '-']) {
      const [match] = matchMediaToAttachments(
        [{ id: hostile, alt: 'the-real-one.png' }],
        attachments,
      );
      // Falls through to the name match — never to "whatever came first".
      expect(match?.id).toBe('10002');
    }
  });

  it('a UUID must appear in Jira’s own (uuid) rename form, not merely somewhere', () => {
    const uuid = '5907207c-5908-4f5a-8468-2ddeb3803481';
    const [loose] = matchMediaToAttachments(
      [{ id: uuid }],
      // The uuid is in the name, but not as Jira's collision marker.
      [att({ id: '10001', fileName: `notes-${uuid}-draft.png` })],
    );
    expect(loose).toBeNull();

    const [real] = matchMediaToAttachments(
      [{ id: uuid }],
      [att({ id: '10002', fileName: `Screenshot (${uuid}).png` })],
    );
    expect(real?.id).toBe('10002');
  });
});

describe('mediaKindOf with mime parameters', () => {
  it('still refuses SVG when the type carries a charset', () => {
    expect(mediaKindOf({ mimeType: 'image/svg+xml; charset=utf-8' })).toBe(
      'other',
    );
    expect(mediaKindOf({ mimeType: 'image/svg+xml;charset=UTF-8' })).toBe(
      'other',
    );
    expect(mediaKindOf({ mimeType: ' IMAGE/SVG+XML ; q=1 ' })).toBe('other');
  });

  it('still recognises ordinary types that carry one', () => {
    expect(mediaKindOf({ mimeType: 'image/png; name=a.png' })).toBe('image');
    expect(mediaKindOf({ mimeType: 'video/mp4; codecs="avc1"' })).toBe('video');
  });
});
