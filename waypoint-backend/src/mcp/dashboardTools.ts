import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JiraCredential } from '../lib/jira/client.js';
import { getJiraProvider, type JiraProvider } from '../providers/jira.js';
import {
  jsonResult,
  notFoundResult,
  validationErrorResult,
  withErrorSafetyNet,
  JIRA_NOT_CONNECTED,
  LIMIT_SCHEMA,
  resolveLimit,
} from './ticketTools.js';

/**
 * Dashboard/gadget/filter tools (ROAD-157) — Copilot's path from "my scrum
 * master's dashboard" to real issues, without hand-written JQL.
 *
 * Jira's public API exposes dashboard metadata and per-gadget configuration,
 * never a gadget's own rendered table (see providers/jira.ts's own header on
 * this section for the detail). So the three tools below form one path:
 * find a dashboard (list_jira_dashboards), see what's on it and what each
 * gadget is bound to (describe_jira_dashboard), then run that binding as a
 * real search narrowed by assignee/issue type (search_dashboard_gadget_
 * issues). Nothing here accepts raw JQL from the model — see that tool's own
 * schema for why.
 */

// Same shape NUMERIC_ID enforces in providers/jira.ts, restated at the
// schema boundary: this is what turns "not a digit string" into a clean
// validation error before the id ever reaches a request path or a JQL
// clause, rather than a provider-level throw the model would see as an
// internal error.
const DASHBOARD_ID = z.string().regex(/^\d+$/, 'must be a numeric dashboard id');
const GADGET_ID = z.string().regex(/^\d+$/, 'must be a numeric gadget id');
const FILTER_ID = z.string().regex(/^\d+$/, 'must be a numeric filter id');
// Same charset providers/jira.ts's ACCOUNT_ID enforces — see that constant's
// own comment for why this is a permissive shape check rather than the
// literal "numeric:uuid" pattern seen in practice.
const ACCOUNT_ID_SCHEMA = z.string().regex(/^[A-Za-z0-9:-]{1,128}$/, 'must be a Jira accountId');

type Jira = JiraProvider | null;

type GadgetIssue = { key: string; summary: string; status: string; issueType: string; updated: string };

// Presentation only — searchIssuesByFilter (providers/jira.ts) returns
// issues flat in Jira's own order; how to bucket them for display is a tool-
// layer decision, matching the division of labor described in that
// provider's own header comment for this section.
function groupIssues(
  issues: GadgetIssue[],
  groupBy: 'issueType' | 'status' | 'none',
): { key: string; count: number; issues: GadgetIssue[] }[] {
  if (groupBy === 'none') return [{ key: 'all', count: issues.length, issues }];
  const byKey = new Map<string, GadgetIssue[]>();
  for (const issue of issues) {
    const key = (groupBy === 'issueType' ? issue.issueType : issue.status) || 'Unknown';
    const list = byKey.get(key) ?? [];
    list.push(issue);
    byKey.set(key, list);
  }
  return [...byKey.entries()].map(([key, issuesForKey]) => ({
    key,
    count: issuesForKey.length,
    issues: issuesForKey,
  }));
}

export async function listJiraDashboardsHandler(
  jira: Jira,
  { nameContains, limit }: { nameContains?: string; limit?: number },
) {
  if (!jira) return validationErrorResult(JIRA_NOT_CONNECTED);
  const dashboards = await jira.listDashboards(nameContains, resolveLimit(limit));
  return jsonResult({ dashboards });
}

// Round-1 review (ROAD-157): describeJiraDashboardHandler fires up to two
// requests PER gadget (one config read, plus one more if that config
// resolves to a filter) — unlike every other list tool in this codebase, a
// dashboard's own gadget count isn't something this app's own query
// controls (see LIMIT_SCHEMA's own doc comment on every other list tool).
// A wide, real, org-shared dashboard could otherwise mean dozens of
// concurrent authenticated Jira requests from one tool call, and Jira
// rate-limiting even one of them fails the whole batch (getGadgetConfig's
// own comment on why 'forbidden' degrades to null rather than throwing
// doesn't help against a genuine 429). Capped well below LIMIT_SCHEMA's own
// ceiling — a dashboard's gadgets are a fixed, author-curated layout, not a
// query result a user would ever want paged through the way a ticket list
// is.
const MAX_GADGETS_TO_DESCRIBE = 25;

export async function describeJiraDashboardHandler(jira: Jira, { dashboardId }: { dashboardId: string }) {
  if (!jira) return validationErrorResult(JIRA_NOT_CONNECTED);
  const allGadgets = await jira.getDashboardGadgets(dashboardId);
  if (!allGadgets) return notFoundResult('dashboard');

  const truncated = allGadgets.length > MAX_GADGETS_TO_DESCRIBE;
  const gadgets = truncated ? allGadgets.slice(0, MAX_GADGETS_TO_DESCRIBE) : allGadgets;

  const described = await Promise.all(
    gadgets.map(async (gadget) => ({
      gadgetId: gadget.id,
      title: gadget.title,
      moduleKey: gadget.moduleKey,
      binding: await jira.resolveGadgetBinding(dashboardId, gadget.id),
    })),
  );
  return jsonResult({ dashboardId, gadgets: described, truncated });
}

export async function searchDashboardGadgetIssuesHandler(
  jira: Jira,
  args: {
    dashboardId?: string;
    gadgetId?: string;
    filterId?: string;
    assigneeScope: 'me' | 'accountId';
    accountId?: string;
    issueTypes?: string[];
    groupBy?: 'issueType' | 'status' | 'none';
    limit?: number;
  },
) {
  if (!jira) return validationErrorResult(JIRA_NOT_CONNECTED);

  const hasDashboard = args.dashboardId !== undefined;
  const hasGadget = args.gadgetId !== undefined;
  if (hasDashboard !== hasGadget) {
    return validationErrorResult('dashboardId and gadgetId must be given together, or neither.');
  }
  const hasDashboardGadget = hasDashboard && hasGadget;
  const hasFilter = args.filterId !== undefined;
  if (hasDashboardGadget === hasFilter) {
    return validationErrorResult(
      'Pass either (dashboardId and gadgetId) to resolve a dashboard gadget automatically, or filterId directly — ' +
        'not both, not neither. If you only have a dashboard, call describe_jira_dashboard first to see its gadgets.',
    );
  }
  if (args.assigneeScope === 'accountId' && !args.accountId) {
    return validationErrorResult('accountId is required when assigneeScope is "accountId".');
  }

  let filterId: string;
  let resolvedFrom: Record<string, unknown>;

  if (hasFilter) {
    filterId = args.filterId as string;
    resolvedFrom = { kind: 'filter', filterId };
  } else {
    const dashboardId = args.dashboardId as string;
    const gadgetId = args.gadgetId as string;
    const binding = await jira.resolveGadgetBinding(dashboardId, gadgetId);

    if (binding.kind === 'unresolved') {
      // A first-class outcome, not an error: hand back what's on the
      // dashboard and what filters this account can see, so Copilot can ask
      // the user which one backs the gadget instead of guessing or giving up.
      const gadgets = await jira.getDashboardGadgets(dashboardId);
      // Narrowed by the gadget's own title, not an unfiltered page of every
      // filter this account can see (round-1 review, ROAD-157) — an
      // unnarrowed search returns whatever 20 filters Jira lists first,
      // which can include filters shared by other users and unrelated to
      // anything this request named; a name-matched set is at least
      // responsive to the dashboard the user actually asked about, and
      // still leaves "no match" (an empty list) as an honest answer rather
      // than a wrong guess.
      const thisGadget = gadgets?.find((g) => g.id === gadgetId);
      const filters = await jira.searchFilters(thisGadget?.title, 20);
      return jsonResult({
        needsBinding: true,
        reason: binding.reason,
        dashboardGadgets: (gadgets ?? []).slice(0, MAX_GADGETS_TO_DESCRIBE),
        visibleFilters: filters,
      });
    }
    if (binding.kind === 'project') {
      return validationErrorResult(
        `This gadget is bound to project "${binding.projectKey}", not a saved filter — ` +
          'search_dashboard_gadget_issues only supports filter-backed gadgets today. ' +
          `Use search_tickets with provider="jira" and projectId="${binding.projectKey}" instead.`,
      );
    }
    filterId = binding.filterId;
    resolvedFrom = {
      kind: 'filter',
      filterId: binding.filterId,
      filterName: binding.filterName,
      dashboardId,
      gadgetId,
    };
  }

  const effectiveLimit = resolveLimit(args.limit);
  const result = await jira.searchIssuesByFilter({
    filterId,
    assigneeScope: args.assigneeScope,
    accountId: args.accountId,
    issueTypes: args.issueTypes,
    limit: effectiveLimit,
  });

  return jsonResult({
    resolvedFrom,
    jql: result.jql,
    total: result.issues.length,
    truncated: result.truncated,
    groups: groupIssues(result.issues, args.groupBy ?? 'issueType'),
  });
}

// Same per-request construction pattern registerTicketTools uses: the
// credential is resolved into a provider once per request, not per call.
export function registerDashboardTools(server: McpServer, jiraCredential: JiraCredential | null): void {
  const jira = getJiraProvider(jiraCredential);

  server.registerTool(
    'list_jira_dashboards',
    {
      description:
        "List Jira dashboards visible to the connected account, optionally narrowed by name. Use this when the user names a dashboard (e.g. \"my scrum master's dashboard\") but you don't already have its numeric id — never invent one.",
      inputSchema: {
        nameContains: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Case-insensitive substring to match against dashboard names.'),
        limit: LIMIT_SCHEMA,
      },
    },
    withErrorSafetyNet(
      'list_jira_dashboards',
      (args: { nameContains?: string; limit?: number }) => listJiraDashboardsHandler(jira, args),
    ),
  );

  server.registerTool(
    'describe_jira_dashboard',
    {
      description:
        "List one dashboard's gadgets, and for each gadget, what it's bound to: a saved filter (with its id, name, and JQL), a project, or \"unresolved\" — a gadget whose configuration doesn't map to either. " +
        'Unresolved is a normal, expected outcome (not every gadget type is a filter/project source) — when you see it and still need that gadget\'s issues, ask the user which saved filter backs it, or call this dashboard\'s search_dashboard_gadget_issues with an explicit filterId if you already know one. ' +
        "Always call this before search_dashboard_gadget_issues so you're citing a real gadget/filter rather than guessing. " +
        'A truncated flag in the result means only the first 25 gadgets on an unusually large dashboard were resolved — tell the user rather than assuming you saw everything.',
      inputSchema: { dashboardId: DASHBOARD_ID.describe('A dashboard id, from list_jira_dashboards.') },
    },
    withErrorSafetyNet(
      'describe_jira_dashboard',
      (args: { dashboardId: string }) => describeJiraDashboardHandler(jira, args),
    ),
  );

  server.registerTool(
    'search_dashboard_gadget_issues',
    {
      description:
        'Get the issues behind one dashboard gadget (or a saved filter directly), narrowed to one assignee and optionally one or more issue types, grouped for display. ' +
        'Pass EITHER (dashboardId and gadgetId) — resolved automatically via the same binding describe_jira_dashboard shows — OR filterId directly, never both. ' +
        'The exact JQL that ran is always echoed back in the result, so the user can audit it or open it in Jira themselves. ' +
        'If the gadget cannot be auto-resolved, this returns needsBinding with the dashboard\'s gadgets and the account\'s visible filters instead of guessing — ask the user which filter backs it. ' +
        'There is no raw-JQL parameter: build the query from filterId/issueTypes/assigneeScope only.',
      inputSchema: {
        dashboardId: DASHBOARD_ID.optional().describe('With gadgetId: the dashboard to resolve a gadget on.'),
        gadgetId: GADGET_ID.optional().describe('With dashboardId: which gadget on it to resolve.'),
        filterId: FILTER_ID.optional().describe('A saved filter id to query directly, skipping gadget resolution.'),
        assigneeScope: z
          .enum(['me', 'accountId'])
          .describe(
            '"me" for the connected account\'s own issues (maps "my"/"mine" in the user\'s request) — never pass an accountId for that. "accountId" to query a specific other person, with accountId set.',
          ),
        accountId: ACCOUNT_ID_SCHEMA.optional().describe('Required, and only used, when assigneeScope is "accountId".'),
        issueTypes: z
          .array(z.string().trim().min(1))
          .optional()
          .describe('e.g. ["Bug","Epic"]. Omit to include every issue type the filter returns.'),
        groupBy: z
          .enum(['issueType', 'status', 'none'])
          .optional()
          .describe('How to bucket the result for display. Default issueType.'),
        limit: LIMIT_SCHEMA,
      },
    },
    withErrorSafetyNet(
      'search_dashboard_gadget_issues',
      (args: {
        dashboardId?: string;
        gadgetId?: string;
        filterId?: string;
        assigneeScope: 'me' | 'accountId';
        accountId?: string;
        issueTypes?: string[];
        groupBy?: 'issueType' | 'status' | 'none';
        limit?: number;
      }) => searchDashboardGadgetIssuesHandler(jira, args),
    ),
  );
}
