import { Router } from 'express';
import { z } from 'zod';
import { JIRA_CREDENTIAL_HEADER, normalizeSite, parseJiraCredentialHeader } from '../lib/jira/credentialHeader.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ConflictError, NotFoundError, ValidationError } from '../middleware/errors.js';
import { getJiraProvider } from '../providers/jira.js';
import { ProviderUnavailableError, type NormalizedTicket } from '../providers/types.js';
import * as ticketRefs from '../services/ticketRefs.service.js';
import { describeAmbiguity, resolveTicketIdentifier } from '../services/ticketResolution.service.js';

/**
 * Ticket handles for the desktop app — W5b (ROAD-126).
 *
 * Three small routes that let a run name a Jira issue the way a proposal
 * already does, by its `tref-` handle (db/schema/integrations.ts):
 *
 *  - GET /tickets/resolve/:identifier — a typed key (`ROAD-116`, `ENG-4`)
 *    to the ticket it names, in either system, through the same dual
 *    lookup Copilot's get_ticket_by_identifier uses
 *    (services/ticketResolution.service.ts). The Jira half needs the
 *    borrowed credential header, exactly as the MCP endpoint does; without
 *    it only native tickets are found. An ambiguous key is a 409 — refused,
 *    never guessed.
 *  - GET /ticket-refs/:id — what a handle stands for: the key, the cached
 *    title, the URL, the site. Display data for a row's label; every read
 *    of the issue's content still goes live.
 *  - POST /ticket-refs — mint (or refresh) a handle for an issue the caller
 *    has just read itself — the My Jira drawer, whose issue came from
 *    main's own Jira client. The site comes from main's stored credential,
 *    never from the renderer; the row holds no secret, and the upsert is
 *    the same one the provider performs on every live read.
 */

export const ticketRefsRouter = Router();

/** A `tref-` id as lib/ids.ts mints it. */
const REF_ID = /^tref-[A-Za-z0-9]{1,64}$/;
/** PROJECT-NUMBER — the Jira provider's own issue-key shape. */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

export interface ResolvedTicketView {
  provider: 'native' | 'jira';
  /** `wi-…` or `tref-…`. */
  id: string;
  identifier: string;
  title: string;
  /** Native: the project id. Jira: the project key. */
  projectId: string;
  url: string | null;
}

function toResolved(ticket: NormalizedTicket): ResolvedTicketView {
  return {
    provider: ticket.provider === 'jira' ? 'jira' : 'native',
    id: ticket.ref,
    identifier: ticket.identifier,
    title: ticket.title,
    projectId: ticket.projectId,
    url: ticket.url,
  };
}

const resolveQuerySchema = z.object({ provider: z.enum(['native', 'jira']).optional() }).strict();

ticketRefsRouter.get(
  '/tickets/resolve/:identifier',
  asyncHandler(async (req, res) => {
    const { provider } = resolveQuerySchema.parse(req.query);
    const jira = getJiraProvider(parseJiraCredentialHeader(req.header(JIRA_CREDENTIAL_HEADER)));
    const identifier = req.params.identifier.trim();
    let outcome;
    try {
      outcome = await resolveTicketIdentifier(jira, identifier, provider);
    } catch (error) {
      // The explicit-provider path lets the provider's own failure through;
      // the dual path already folds it into `unavailable`.
      if (error instanceof ProviderUnavailableError) {
        throw new ConflictError(`Jira could not be reached: ${error.message}`);
      }
      throw error;
    }
    switch (outcome.kind) {
      case 'found':
        res.json(toResolved(outcome.ticket));
        return;
      case 'ambiguous':
        throw new ConflictError(
          `${describeAmbiguity(identifier, outcome.native, outcome.jira)} ` +
            'Open the one you mean and use its Sessions section.',
        );
      case 'unavailable':
        throw new ConflictError(`Jira could not be reached: ${outcome.error.message}`);
      case 'jira_off':
        throw new ValidationError('Jira is not connected');
      case 'missing':
        throw new NotFoundError('ticket');
    }
  }),
);

export interface TicketRefView {
  id: string;
  provider: string;
  site: string | null;
  /** The provider's own id for the issue — the key, for Jira. */
  externalId: string;
  identifier: string;
  title: string;
  url: string | null;
  lastSeenAt: Date;
}

function toRefView(row: ticketRefs.TicketRefRow): TicketRefView {
  return {
    id: row.id,
    provider: row.provider,
    site: row.externalSite,
    externalId: row.externalId,
    identifier: row.cachedIdentifier,
    title: row.cachedTitle,
    url: row.cachedUrl,
    lastSeenAt: row.lastSeenAt,
  };
}

ticketRefsRouter.get(
  '/ticket-refs/:id',
  asyncHandler(async (req, res) => {
    if (!REF_ID.test(req.params.id)) throw new NotFoundError('ticket ref');
    const row = await ticketRefs.findById(req.params.id);
    if (!row) throw new NotFoundError('ticket ref');
    res.json(toRefView(row));
  }),
);

const rememberRefSchema = z
  .object({
    provider: z.literal('jira'),
    site: z.string().min(1).max(253),
    // The issue key; Jira's own identity for the issue and what a person types.
    key: z.string().min(1).max(64).regex(ISSUE_KEY, 'not a Jira issue key'),
    title: z.string().max(1000).default(''),
  })
  .strict();

ticketRefsRouter.post(
  '/ticket-refs',
  asyncHandler(async (req, res) => {
    const input = rememberRefSchema.parse(req.body);
    // The same normalization the credential header gets: the site a row
    // records must be byte-equal to the site the provider will later compare
    // it against on a read or a write (JiraProvider.resolveKey).
    const site = normalizeSite(input.site);
    if (!site) throw new ValidationError('not a Jira site');
    const key = input.key.toUpperCase();
    const row = await ticketRefs.remember({
      provider: 'jira',
      site,
      externalId: key,
      identifier: key,
      title: input.title,
      url: `https://${site}/browse/${encodeURIComponent(key)}`,
    });
    res.status(201).json(toRefView(row));
  }),
);
