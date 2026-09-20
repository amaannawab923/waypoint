import type { TranscriptTurn } from '@emdash/core/runtimes/acp/api/client' with {
  'resolution-mode': 'import',
};
import type { ViewerImage } from './ImageViewer';

/**
 * Every image a tool returned in the transcript, in the order it was
 * taken: turns in order, items by `seq`, a tool group's children inside
 * it, each tool call's images in order. The ids match chat-ui's own
 * (`<item id>:image:<n>`, tool.def.ts on the emdash fork), so the image
 * chat-ui hands `onViewImage` is found in this list by id. Pure.
 */
export function collectTranscriptImages(
  turns: readonly TranscriptTurn[],
): ViewerImage[] {
  const out: ViewerImage[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const item = node as {
      id?: unknown;
      images?: unknown;
      children?: unknown;
    };
    if (Array.isArray(item.images) && typeof item.id === 'string') {
      item.images.forEach((image, i) => {
        const img = image as { mimeType?: unknown; data?: unknown };
        if (typeof img.mimeType !== 'string' || typeof img.data !== 'string')
          return;
        out.push({
          id: `${item.id}:image:${i}`,
          name: `Image ${out.length + 1}`,
          dataUrl: `data:${img.mimeType};base64,${img.data}`,
        });
      });
    }
    if (Array.isArray(item.children)) item.children.forEach(visit);
  };
  turns.forEach((turn) => {
    [...turn.items].sort((a, b) => a.seq - b.seq).forEach(visit);
  });
  return out;
}
