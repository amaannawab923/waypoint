import { ipcMain } from 'electron';
import {
  deleteStoredJiraCredential,
  isJiraSecureStorageAvailable,
  readStoredJiraCredential,
  toJiraIdentity,
  writeStoredJiraCredential,
} from './jiraAuth';
import * as client from './jiraClient';
import { normalizeJiraSite } from './jiraMap';
import type {
  JiraConnectionSnapshot,
  JiraFailure,
  JiraIdentity,
  JiraResult,
  JiraWireComment,
  JiraWireTicket,
  JiraWireTransition,
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

export function registerJiraIpc(): void {
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
      const body = readString(input.body);
      if (!ticketId) return failure('invalid_input', 'Unknown Jira issue.');
      if (!body) return failure('invalid_input', 'Write something first.');
      return client.postComment(ticketId, body);
    },
  );
}
