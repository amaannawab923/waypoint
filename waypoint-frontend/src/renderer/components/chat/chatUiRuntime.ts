/**
 * The one place Waypoint imports the vendored emdash chat-ui build — ROAD-59.
 *
 * `@emdash/chat-ui` resolves (tsconfig paths, mirrored into webpack) to
 * `vendor/emdash-chat-ui/chat-ui/`, an unmodified build of emdash's
 * Solid.js transcript renderer at the same emdash commit as the engine,
 * fetched by hash by scripts/fetch-chat-ui.mjs (chat-ui.lock.json). Apache
 * License 2.0, © General Action, Inc. — the license and NOTICE travel
 * inside the archive.
 *
 * Its stylesheet is loaded here, once, into the document — the same way
 * emdash mounts it (light DOM, not a shadow root): chat-ui measures text
 * with pretext and waits on `document.fonts.load()`, both of which need
 * its `@font-face` rules registered at document level. The stylesheet's
 * element-level reset (`*` box-sizing, `p/h1…` margin 0, `ul/ol`
 * list-style none, `table` border-collapse separate) is what Tailwind's
 * preflight already imposes on this app, and every Waypoint element that
 * wants otherwise says so with a utility class, which beats an element
 * selector regardless of order.
 *
 * Every consumer goes through `getChatUiRuntime()` rather than importing
 * the package: jest maps this module's import to a fake (package.json
 * `moduleNameMapper`), so component tests never load 3.8 MB of Solid.
 */
import * as chatUi from '@emdash/chat-ui';
import '@emdash/chat-ui/style.css';

export type ChatUiRuntime = Pick<
  typeof chatUi,
  | 'connectSession'
  | 'createChatContext'
  | 'createChatState'
  | 'createChatView'
  | 'createDefaultHighlighter'
  | 'tailMode'
  | 'pinTopMode'
>;

const runtime: ChatUiRuntime = {
  connectSession: chatUi.connectSession,
  createChatContext: chatUi.createChatContext,
  createChatState: chatUi.createChatState,
  createChatView: chatUi.createChatView,
  createDefaultHighlighter: chatUi.createDefaultHighlighter,
  tailMode: chatUi.tailMode,
  pinTopMode: chatUi.pinTopMode,
};

export function getChatUiRuntime(): ChatUiRuntime {
  return runtime;
}
