/**
 * ChatTranscript — React adapter for the vendored @emdash/chat-ui (ROAD-59).
 *
 * Derived from emdash's own React wrapper,
 * apps/emdash-desktop/src/core/features/conversations/api/browser/chat/chat-transcript.ts
 * at commit 9b102a5f3 (Apache License 2.0, Copyright 2026 General Action,
 * Inc. — see vendor/emdash-chat-ui/LICENSE.md). Modifications for
 * Waypoint: imports through chatUiRuntime.ts, JSX instead of
 * createElement (Waypoint has one JSX runtime — React — so the dual-runtime
 * concern emdash avoided does not exist here), and the prop surface
 * trimmed to what the sessions panel (W3) uses.
 *
 * The shape is CodeMirror's EditorState/EditorView split, which chat-ui
 * mirrors: the host owns the model (`ChatContext` once per app,
 * `ChatState` per conversation) and this component owns the DOM view — a
 * Solid root created into the container div on mount and disposed on
 * unmount. React never re-renders the transcript: every later change
 * reaches the view through `setModel` / `setContentPadding` /
 * `setCommands`, and callbacks read the latest props through a ref so an
 * inline arrow is never stale.
 */
import { useEffect, useRef, type CSSProperties } from 'react';
import type {
  ChatCommands,
  ChatContext,
  ChatState,
  ChatView,
  ChatViewOptions,
} from '@emdash/chat-ui';
import { getChatUiRuntime } from './chatUiRuntime';

export type ChatTranscriptProps = Pick<
  ChatViewOptions,
  | 'stickToBottom'
  | 'pinUserMessages'
  | 'composer'
  | 'composerPlacement'
  | 'contentOverlay'
  | 'class'
  | 'contentClass'
  | 'onReachStart'
  | 'onAtBottomChange'
> & {
  /** Global services singleton shared across conversations. */
  context: ChatContext;
  /** Per-conversation state (transcript + parse caches). */
  state: ChatState;
  /** Called once after the Solid root is mounted with the chat view handle. */
  onReady?: (view: ChatView) => void;
  style?: CSSProperties;
  className?: string;
  /**
   * Top padding (px) reserved inside the canvas for a pinned header.
   * Pushed reactively via setContentPadding so it can change without a
   * remount.
   */
  padTop?: number;
  /**
   * Command callbacks invoked by user interactions inside the transcript.
   * Pushed reactively so inline callbacks are never stale.
   */
  commands?: ChatCommands;
};

export function ChatTranscript(props: ChatTranscriptProps) {
  const ref = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const viewRef = useRef<ChatView | null>(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    const p = propsRef.current;
    const view = getChatUiRuntime().createChatView({
      context: p.context,
      state: p.state,
      parent: ref.current,
      composer: p.composer,
      composerPlacement: p.composerPlacement,
      contentOverlay: p.contentOverlay,
      stickToBottom: p.stickToBottom,
      pinUserMessages: p.pinUserMessages,
      class: p.class,
      contentClass: p.contentClass,
      commands: p.commands ?? {},
      padTop: p.padTop,
      // Stable wrappers that read from propsRef at call time — never stale.
      onReachStart: p.onReachStart
        ? () => propsRef.current.onReachStart?.()
        : undefined,
      onAtBottomChange: p.onAtBottomChange
        ? (atBottom: boolean) => propsRef.current.onAtBottomChange?.(atBottom)
        : undefined,
      onViewMounted: (mounted) => propsRef.current.onReady?.(mounted),
    });
    viewRef.current = view;

    return () => {
      view.dispose();
      viewRef.current = null;
    };
    // Mount once: everything that can change later is pushed through the
    // view handle by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the underlying ChatState when props.state identity changes. The
  // view handle, composer slot and commands stay stable across swaps.
  useEffect(() => {
    viewRef.current?.setModel(props.state);
  }, [props.state]);

  useEffect(() => {
    viewRef.current?.setContentPadding({ top: props.padTop });
  }, [props.padTop]);

  useEffect(() => {
    if (props.commands !== undefined) {
      viewRef.current?.setCommands(props.commands);
    }
  }, [props.commands]);

  return (
    <div
      ref={ref}
      data-testid="chat-transcript"
      style={{ height: '100%', ...props.style }}
      className={props.className}
    />
  );
}

export type {
  ChatView,
  ChatCommands,
  ChatContext,
  ChatState,
  TranscriptTurn,
  TranscriptItem,
  ToolNode,
  AcpPermissionRequest,
  PlanState,
  ConnectSessionSource,
} from '@emdash/chat-ui';
