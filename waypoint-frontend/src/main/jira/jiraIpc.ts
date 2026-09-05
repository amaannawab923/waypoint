import { ipcMain, type BrowserWindow } from 'electron';
import {
  deleteStoredJiraCredential,
  isJiraSecureStorageAvailable,
  readStoredJiraCredential,
  toJiraIdentity,
  writeStoredJiraCredential,
} from './jiraAuth';
import * as client from './jiraClient';
import * as files from './jiraFiles';
import { normalizeJiraSite } from './jiraMap';
import type {
  JiraAdfAnyMark,
  JiraAdfBlockNode,
  JiraAdfBlockquote,
  JiraAdfBulletList,
  JiraAdfCodeBlock,
  JiraAdfHeading,
  JiraAdfInlineNode,
  JiraAdfListItem,
  JiraAdfOrderedList,
  JiraAdfParagraph,
  JiraAdfTextNode,
  JiraCommentBody,
  JiraConnectionSnapshot,
  JiraFailure,
  JiraIdentity,
  JiraPriorityOption,
  JiraResult,
  JiraWireComment,
  JiraWireTicket,
  JiraWireTransition,
  JiraWireUser,
} from './jiraTypes';

// Every `jira:*` channel, in one place. Request/response (`ipcMain.handle`)
// throughout — unlike the Copilot connect flow, nothing here produces a
// stream, so there is no reason for any of it to be a send/on pair.
//
// Two rules this file exists to hold:
//
//  1. Nothing that crosses back to the renderer contains the API token. The
//     only credential-derived shape any handler returns is JiraIdentity,
//     built by jiraAuth.ts's toJiraIdentity().
//  2. Renderer input is validated here, at the boundary, not deeper. The
//     renderer is this app's own code, but IPC is still an external input to
//     the privileged process, and "the site the token is sent to" is not a
//     value worth taking on trust from a caller.

function failure(reason: JiraFailure['reason'], message: string): JiraFailure {
  return { ok: false, reason, message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Guards every per-ticket channel. Jira issue ids and keys are alphanumeric
 * with a hyphen at most — refusing anything else here means no caller-supplied
 * value can ever escape into a REST path, on top of the encodeURIComponent
 * the client already applies. */
function readTicketId(value: unknown): string | null {
  const id = readString(value);
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(id) ? id : null;
}

/**
 * Guards the attachment channels.
 *
 * Its own function rather than a reuse of `readTicketId`, because the two
 * guard different things and saying so is worth a name: an attachment id on
 * Jira Cloud is a small integer as a string ("10050"), not an issue key. The
 * character class is deliberately no looser than the ticket guard's — the
 * property that matters is identical, that nothing caller-supplied can escape
 * into a REST path — and deliberately no tighter, i.e. not pinned to digits.
 * Pinning it would buy no additional safety (a path cannot be spelled in
 * `[A-Za-z0-9_-]` either way) while breaking downloads outright on any site,
 * proxy or future API version whose ids are not purely numeric.
 */
function readAttachmentId(value: unknown): string | null {
  const id = readString(value);
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(id) ? id : null;
}

/** Only string-valued entries survive: the transition popover collects text
 * and select values, and anything else arriving under this key is not
 * something the renderer sends. */
function readFieldValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<
    Record<string, string>
  >(
    (out, [key, raw]) =>
      typeof raw === 'string' ? { ...out, [key]: raw } : out,
    {},
  );
}

/**
 * Guards the comment-post channel's body.
 *
 * The renderer's composer builds this shape itself (see jiraApi.ts's
 * `buildCommentAdf`), so this isn't validating against a hostile author —
 * it's the same boundary rule every other channel here follows: nothing
 * caller-supplied reaches `client.postComment`'s network call unchecked.
 * Only the node, mark and block kinds the composer's markdown-lite subset
 * can ever produce survive; anything else is dropped rather than forwarded,
 * so a malformed doc fails here with a clear message instead of an opaque
 * 400 from Jira.
 *
 * One rule threads through every reader below and is not incidental: a
 * `mention` node never carries `marks`, on read or on write. Live-confirmed
 * against the real API that Jira's comment-create endpoint 400s on a bold
 * mention while every other combination here succeeds — so a mention with a
 * `marks` array attached is treated the same as any other malformed node
 * rather than silently stripped, keeping this reader's contract "produces
 * exactly what it validates" rather than quietly rewriting caller input.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readMark(raw: unknown): JiraAdfAnyMark | null {
  if (!isRecord(raw)) return null;
  if (
    raw.type === 'strong' ||
    raw.type === 'em' ||
    raw.type === 'strike' ||
    raw.type === 'code'
  ) {
    return { type: raw.type };
  }
  if (
    raw.type === 'link' &&
    isRecord(raw.attrs) &&
    typeof raw.attrs.href === 'string'
  ) {
    return { type: 'link', attrs: { href: raw.attrs.href } };
  }
  return null;
}

/** `undefined` (no `marks` key at all) is valid and means "no marks" — the
 * common case for plain text and the only legal state for a mention. An
 * absent key and an explicit `marks: []` are both accepted and treated
 * alike; only a present-but-invalid entry fails the whole node. */
function readOptionalMarks(raw: unknown): JiraAdfAnyMark[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  const marks = raw.map(readMark);
  return marks.some((m) => m === null) ? null : (marks as JiraAdfAnyMark[]);
}

function readInlineNode(raw: unknown): JiraAdfInlineNode | null {
  if (!isRecord(raw)) return null;
  if (raw.type === 'text' && typeof raw.text === 'string') {
    const marks = readOptionalMarks(raw.marks);
    if (marks === null) return null;
    return marks
      ? { type: 'text', text: raw.text, marks }
      : { type: 'text', text: raw.text };
  }
  if (
    raw.type === 'mention' &&
    raw.marks === undefined &&
    isRecord(raw.attrs) &&
    typeof raw.attrs.id === 'string' &&
    typeof raw.attrs.text === 'string'
  ) {
    return {
      type: 'mention',
      attrs: { id: raw.attrs.id, text: raw.attrs.text },
    };
  }
  return null;
}

function readInlineContent(raw: unknown): JiraAdfInlineNode[] | null {
  if (!Array.isArray(raw)) return null;
  const nodes = raw.map(readInlineNode);
  return nodes.some((n) => n === null) ? null : (nodes as JiraAdfInlineNode[]);
}

function readParagraph(raw: unknown): JiraAdfParagraph | null {
  if (!isRecord(raw) || raw.type !== 'paragraph') return null;
  const content = readInlineContent(raw.content);
  return content ? { type: 'paragraph', content } : null;
}

function readHeading(raw: unknown): JiraAdfHeading | null {
  if (!isRecord(raw) || raw.type !== 'heading') return null;
  const level = isRecord(raw.attrs) ? raw.attrs.level : null;
  if (level !== 1 && level !== 2 && level !== 3) return null;
  const content = readInlineContent(raw.content);
  return content ? { type: 'heading', attrs: { level }, content } : null;
}

function readListItem(raw: unknown): JiraAdfListItem | null {
  if (
    !isRecord(raw) ||
    raw.type !== 'listItem' ||
    !Array.isArray(raw.content)
  ) {
    return null;
  }
  const paragraphs = raw.content.map(readParagraph);
  return paragraphs.some((p) => p === null)
    ? null
    : { type: 'listItem', content: paragraphs as JiraAdfParagraph[] };
}

function readList(
  raw: unknown,
  kind: 'bulletList' | 'orderedList',
): JiraAdfBulletList | JiraAdfOrderedList | null {
  if (!isRecord(raw) || raw.type !== kind || !Array.isArray(raw.content)) {
    return null;
  }
  const items = raw.content.map(readListItem);
  return items.some((i) => i === null)
    ? null
    : { type: kind, content: items as JiraAdfListItem[] };
}

function readBlockquote(raw: unknown): JiraAdfBlockquote | null {
  if (
    !isRecord(raw) ||
    raw.type !== 'blockquote' ||
    !Array.isArray(raw.content)
  ) {
    return null;
  }
  const paragraphs = raw.content.map(readParagraph);
  return paragraphs.some((p) => p === null)
    ? null
    : { type: 'blockquote', content: paragraphs as JiraAdfParagraph[] };
}

/** A code fence's content is plain text only -- no marks, no mentions, so
 * this reads `text` nodes directly rather than through `readInlineNode`,
 * which would happily accept a mark or a mention that Jira's own codeBlock
 * schema does not represent. */
function readCodeBlock(raw: unknown): JiraAdfCodeBlock | null {
  if (
    !isRecord(raw) ||
    raw.type !== 'codeBlock' ||
    !Array.isArray(raw.content)
  ) {
    return null;
  }
  const lines = raw.content.map((node): JiraAdfTextNode | null =>
    isRecord(node) &&
    node.type === 'text' &&
    typeof node.text === 'string' &&
    node.marks === undefined
      ? { type: 'text', text: node.text }
      : null,
  );
  return lines.some((l) => l === null)
    ? null
    : { type: 'codeBlock', content: lines as JiraAdfTextNode[] };
}

function readBlockNode(raw: unknown): JiraAdfBlockNode | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case 'paragraph':
      return readParagraph(raw);
    case 'heading':
      return readHeading(raw);
    case 'bulletList':
      return readList(raw, 'bulletList');
    case 'orderedList':
      return readList(raw, 'orderedList');
    case 'blockquote':
      return readBlockquote(raw);
    case 'codeBlock':
      return readCodeBlock(raw);
    default:
      return null;
  }
}

function readCommentBody(value: unknown): JiraCommentBody | null {
  if (
    !isRecord(value) ||
    value.type !== 'doc' ||
    !Array.isArray(value.content)
  ) {
    return null;
  }
  const content = value.content.map(readBlockNode);
  if (content.some((b) => b === null)) return null;
  return { type: 'doc', version: 1, content: content as JiraAdfBlockNode[] };
}

function inlineHasContent(nodes: JiraAdfInlineNode[]): boolean {
  return nodes.some((n) => n.type === 'mention' || n.text.trim().length > 0);
}

/** Whether a validated comment body has anything a user would recognize as
 * content — at least one non-blank text run or one mention, anywhere in the
 * (possibly nested) block structure. A doc made of empty paragraphs is what
 * an all-whitespace draft turns into once trimmed block-by-block, and
 * posting that to Jira is the same empty-comment mistake `readString`'s
 * truthiness check already guards against elsewhere on this channel. */
function commentBodyHasContent(body: JiraCommentBody): boolean {
  return body.content.some((block) => {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        return inlineHasContent(block.content);
      case 'bulletList':
      case 'orderedList':
        return block.content.some((item) =>
          item.content.some((p) => inlineHasContent(p.content)),
        );
      case 'blockquote':
        return block.content.some((p) => inlineHasContent(p.content));
      case 'codeBlock':
        return block.content.some((t) => t.text.trim().length > 0);
      default:
        return false;
    }
  });
}

/**
 * `getWindow` is a getter rather than a window, matching `registerRepoLinkIpc`
 * and `registerCopilotIpc` exactly and for their reason: registration happens
 * once at module load, when `mainWindow` is still null, and a window closed and
 * reopened later is a *different* object. A dialog parented to the window that
 * existed at startup would be parented to nothing.
 *
 * A null answer is a real case rather than an error — the dialogs then open
 * free-floating instead of as a sheet.
 */
export function registerJiraIpc(getWindow: () => BrowserWindow | null): void {
  // A purely local read of the credential store — deliberately not a network
  // round trip. The sidebar and the My Jira page both ask for this on every
  // mount, and "is an account connected" is answered by the file on disk;
  // making it a request to Atlassian would put a network call in front of
  // rendering a nav item.
  ipcMain.handle('jira:status', (): JiraConnectionSnapshot => {
    const credential = readStoredJiraCredential();
    return {
      connected: credential !== null,
      identity: credential ? toJiraIdentity(credential) : null,
    };
  });

  ipcMain.handle(
    'jira:connect',
    async (_event, args: unknown): Promise<JiraResult<JiraIdentity>> => {
      const input = (args ?? {}) as Record<string, unknown>;
      const site = normalizeJiraSite(readString(input.site));
      const email = readString(input.email);
      const apiToken = readString(input.apiToken);

      if (!site) {
        return failure(
          'invalid_input',
          'Enter your Jira site address, e.g. yourteam.atlassian.net.',
        );
      }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return failure(
          'invalid_input',
          'Enter the email address of your Atlassian account.',
        );
      }
      if (!apiToken) {
        return failure(
          'invalid_input',
          'Paste an API token from id.atlassian.com › Security › API tokens.',
        );
      }
      // Checked before the network call, not after: validating a token this
      // app has already decided it cannot store would mean sending a real
      // credential to Atlassian purely to then throw the result away.
      if (!isJiraSecureStorageAvailable()) {
        return failure(
          'storage_unavailable',
          "Secure storage isn't available on this system, so an API token can't be saved safely here.",
        );
      }

      const validated = await client.validateCredential({
        site,
        email,
        apiToken,
      });
      if (!validated.ok) return validated;

      const identity = validated.value;
      try {
        writeStoredJiraCredential({
          site,
          email,
          apiToken,
          accountId: identity.accountId,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
        });
      } catch {
        // Resolved, never rejected — the same hazard copilotAuth.ts's save
        // handler documents: a locked keychain or a full disk here must not
        // leave the connect button's `await` hanging forever with a validated
        // credential silently dropped.
        return failure(
          'storage_unavailable',
          "Those credentials work, but they couldn't be saved securely on this device — try again.",
        );
      }
      return { ok: true, value: identity };
    },
  );

  // Removes the stored credential outright rather than marking it inactive.
  // A disconnected account must leave nothing behind that could still
  // authenticate.
  ipcMain.handle('jira:disconnect', (): { ok: true } => {
    deleteStoredJiraCredential();
    return { ok: true };
  });

  ipcMain.handle(
    'jira:tickets:list',
    (): Promise<JiraResult<JiraWireTicket[]>> => client.listMyTickets(),
  );

  ipcMain.handle(
    'jira:tickets:transitions',
    async (
      _event,
      rawTicketId: unknown,
    ): Promise<JiraResult<JiraWireTransition[]>> => {
      const ticketId = readTicketId(rawTicketId);
      if (!ticketId) return failure('invalid_input', 'Unknown Jira issue.');
      return client.listTransitions(ticketId);
    },
  );

  ipcMain.handle(
    'jira:tickets:transition',
    async (_event, args: unknown): Promise<JiraResult<JiraWireTicket>> => {
      const input = (args ?? {}) as Record<string, unknown>;
      const ticketId = readTicketId(input.ticketId);
      const transitionId = readString(input.transitionId);
      if (!ticketId) return failure('invalid_input', 'Unknown Jira issue.');
      if (!transitionId) {
        return failure('invalid_input', 'Pick a transition first.');
      }
      return client.transitionTicket(
        ticketId,
        transitionId,
        readFieldValues(input.fieldValues),
      );
    },
  );

  ipcMain.handle(
    'jira:tickets:priority-options',
    async (
      _event,
      rawTicketId: unknown,
    ): Promise<JiraResult<JiraPriorityOption[]>> => {
      const ticketId = readTicketId(rawTicketId);
      if (!ticketId) return failure('invalid_input', 'Unknown Jira issue.');
      return client.listPriorityOptions(ticketId);
    },
  );

  ipcMain.handle(
    'jira:tickets:set-priority',
    async (_event, args: unknown): Promise<JiraResult<JiraWireTicket>> => {
      const input = (args ?? {}) as Record<string, unknown>;
      const ticketId = readTicketId(input.ticketId);
      // A priority id never reaches a URL path — it goes in a JSON body — so
      // the only check it needs is that it is a non-empty string, the same
      // treatment `transitionId` gets one handler up.
      const priorityId = readString(input.priorityId);
      if (!ticketId) return failure('invalid_input', 'Unknown Jira issue.');
      if (!priorityId)
        return failure('invalid_input', 'Pick a priority first.');
      return client.setTicketPriority(ticketId, priorityId);
    },
  );

  // The issue KEY, not the id, and that is Jira's contract rather than this
  // app's preference: `/user/assignable/search` takes `issueKey`. The same
  // validator guards it — an issue key is PROJECT-NUMBER, which is exactly the
  // alphanumeric-with-a-hyphen shape readTicketId already allows, so the check
  // holds without being loosened for this one channel.
  ipcMain.handle(
    'jira:tickets:assignable-users',
    async (_event, args: unknown): Promise<JiraResult<JiraWireUser[]>> => {
      const input = (args ?? {}) as Record<string, unknown>;
      const ticketKey = readTicketId(input.ticketKey);
      if (!ticketKey) return failure('invalid_input', 'Unknown Jira issue.');
      // A blank query is legitimate — it is what the picker sends on open, and
      // Jira answers it with the first page of assignable users. Trimmed but
      // not rejected.
      return client.searchAssignableUsers(ticketKey, readString(input.query));
    },
  );

  ipcMain.handle(
    'jira:tickets:set-assignee',
    async (_event, args: unknown): Promise<JiraResult<JiraWireTicket>> => {
      const input = (args ?? {}) as Record<string, unknown>;
      const ticketId = readTicketId(input.ticketId);
      if (!ticketId) return failure('invalid_input', 'Unknown Jira issue.');

      // The order here is the whole point of this handler.
      //
      // `null` is a real, meaningful value on this channel: it is Jira's own
      // documented payload for "unassign", and the picker's Unassign row sends
      // exactly that. `readString` turns `null` into `''` — so running the
      // account id through it first would fold "the user chose nobody" into
      // the same empty string as "the renderer sent no field at all", and this
      // handler would have no way left to tell an intentional unassign from a
      // malformed call. Checking for the literal `null` BEFORE any string
      // coercion is what keeps the two apart end to end.
      if (input.accountId === null)
        return client.setTicketAssignee(ticketId, null);

      const accountId = readString(input.accountId);
      if (!accountId) {
        return failure('invalid_input', 'Pick someone to assign this to.');
      }
      return client.setTicketAssignee(ticketId, accountId);
    },
  );

  /**
   * Downloads one attachment and lets the user say where it goes.
   *
   * Note what this channel does NOT take, in either direction: a filesystem
   * path. The renderer cannot name a destination, and none comes back. Main
   * fetches the bytes, opens a native save dialog, and writes — the whole
   * round trip inside one handler, with the path existing only between the
   * dialog that produced it and the write that consumed it. The dialog is the
   * authorization, which is why there is nothing here to validate about where
   * the file lands.
   *
   * `fileName` is a suggestion for the dialog's default and nothing else. It
   * is attacker-influenced (any Jira user can name a file
   * `../../../.ssh/authorized_keys`), so `jiraFiles.safeBaseName` reduces it
   * to a bare name before it reaches the dialog; it never becomes a path here.
   *
   * `ticketId` is validated and then unused, deliberately: Jira's
   * attachment-content endpoint is addressed by attachment id alone, so the
   * ticket id builds no part of the request. It stays on the channel because
   * it is what makes the call self-describing at both ends — every other
   * per-issue channel names its issue, and a download is an action on a
   * ticket even when the URL doesn't say so.
   *
   * The saved path is narrowed off the answer here rather than passed
   * through. `downloadAttachmentToDisk` reports it because a main-process
   * caller may reasonably want it, but "no path crosses IPC" is a claim about
   * both directions and this is the direction it would otherwise leak in. The
   * renderer gets a boolean, which is all it can act on anyway.
   */
  ipcMain.handle(
    'jira:attachments:download',
    async (
      _event,
      args: unknown,
    ): Promise<JiraResult<{ canceled: boolean }>> => {
      const input = (args ?? {}) as Record<string, unknown>;
      const ticketId = readTicketId(input.ticketId);
      const attachmentId = readAttachmentId(input.attachmentId);
      if (!ticketId) return failure('invalid_input', 'Unknown Jira issue.');
      if (!attachmentId) {
        return failure('invalid_input', 'Unknown Jira attachment.');
      }
      const saved = await files.downloadAttachmentToDisk(
        getWindow(),
        attachmentId,
        readString(input.fileName),
      );
      if (!saved.ok) return saved;
      return { ok: true, value: { canceled: saved.value.canceled } };
    },
  );

  /**
   * Attaches a file to an issue.
   *
   * The payload is one issue id, and that is the whole argument list. No
   * filename, no path — main discovers the file through its own native picker,
   * so the renderer cannot name what gets read off this machine. There is
   * consequently nothing here to validate about the file: the dialog is the
   * authorization, and it can only produce something the user chose in it.
   *
   * The answer carries the full re-read ticket rather than a bare "it worked",
   * matching every other write on this boundary. That is what lets the
   * renderer patch its cached list with `.map()` — a ticket with a new
   * attachment on it, from Jira, rather than one this app assembled by
   * guessing what the upload did.
   */
  ipcMain.handle(
    'jira:attachments:upload',
    async (
      _event,
      args: unknown,
    ): Promise<JiraResult<{ canceled: boolean; ticket?: JiraWireTicket }>> => {
      const input = (args ?? {}) as Record<string, unknown>;
      const ticketId = readTicketId(input.ticketId);
      if (!ticketId) return failure('invalid_input', 'Unknown Jira issue.');
      return files.pickAndUploadAttachment(getWindow(), ticketId);
    },
  );

  ipcMain.handle(
    'jira:comments:list',
    async (
      _event,
      rawTicketId: unknown,
    ): Promise<JiraResult<JiraWireComment[]>> => {
      const ticketId = readTicketId(rawTicketId);
      if (!ticketId) return failure('invalid_input', 'Unknown Jira issue.');
      return client.listComments(ticketId);
    },
  );

  ipcMain.handle(
    'jira:comments:post',
    async (_event, args: unknown): Promise<JiraResult<JiraWireComment>> => {
      const input = (args ?? {}) as Record<string, unknown>;
      const ticketId = readTicketId(input.ticketId);
      const body = readCommentBody(input.body);
      if (!ticketId) return failure('invalid_input', 'Unknown Jira issue.');
      if (!body || !commentBodyHasContent(body)) {
        return failure('invalid_input', 'Write something first.');
      }
      return client.postComment(ticketId, body);
    },
  );
}
