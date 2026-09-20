import type { TranscriptTurn } from '@emdash/core/runtimes/acp/api/client' with {
  'resolution-mode': 'import',
};
import { collectTranscriptImages } from './transcriptImages';

const png = (data: string) => ({ mimeType: 'image/png', data });

function turn(id: string, seq: number, items: unknown[]): TranscriptTurn {
  return { id, seq, items } as unknown as TranscriptTurn;
}

describe('collectTranscriptImages', () => {
  it('walks turns in order, items by seq, groups into their children, images in order — with chat-ui ids', () => {
    const turns = [
      turn('t1', 1, [
        { kind: 'message', id: 'm1', seq: 1, role: 'user', text: 'go' },
        // Out of seq order on purpose: the second screenshot listed first.
        {
          kind: 'unknown-tool-call',
          id: 'shot-2',
          seq: 5,
          images: [png('B')],
        },
        {
          kind: 'unknown-tool-call',
          id: 'shot-1',
          seq: 3,
          images: [png('A1'), png('A2')],
        },
        {
          kind: 'tool-group',
          id: 'g',
          seq: 6,
          children: [
            { kind: 'mcp-tool-call', id: 'shot-3', seq: 1, images: [png('C')] },
          ],
        },
        { kind: 'execute-tool-call', id: 'x', seq: 7, outputText: 'no images' },
      ]),
      turn('t2', 2, [
        { kind: 'unknown-tool-call', id: 'shot-4', seq: 1, images: [png('D')] },
      ]),
    ];
    expect(collectTranscriptImages(turns)).toEqual([
      {
        id: 'shot-1:image:0',
        name: 'Image 1',
        dataUrl: 'data:image/png;base64,A1',
      },
      {
        id: 'shot-1:image:1',
        name: 'Image 2',
        dataUrl: 'data:image/png;base64,A2',
      },
      {
        id: 'shot-2:image:0',
        name: 'Image 3',
        dataUrl: 'data:image/png;base64,B',
      },
      {
        id: 'shot-3:image:0',
        name: 'Image 4',
        dataUrl: 'data:image/png;base64,C',
      },
      {
        id: 'shot-4:image:0',
        name: 'Image 5',
        dataUrl: 'data:image/png;base64,D',
      },
    ]);
  });

  it('skips malformed images and yields nothing for a transcript without any', () => {
    expect(
      collectTranscriptImages([
        turn('t', 1, [
          {
            kind: 'unknown-tool-call',
            id: 'a',
            seq: 1,
            images: [{ mimeType: 'image/png' }, { data: 'x' }],
          },
          { kind: 'message', id: 'm', seq: 2, role: 'assistant', text: 'hi' },
        ]),
      ]),
    ).toEqual([]);
    expect(collectTranscriptImages([])).toEqual([]);
  });
});
