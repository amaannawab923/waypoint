import {
  fitScale,
  isViewable,
  jiraMediaUrl,
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
