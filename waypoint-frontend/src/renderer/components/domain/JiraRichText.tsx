import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  CheckCircle2,
  ImageOff,
  Info,
  StickyNote,
  XCircle,
} from 'lucide-react';

/**
 * Renders a Jira description/comment body.
 *
 * `adf` is the raw Atlassian Document Format node (see
 * `JiraWireTicket.descriptionAdf`), `fallback` the already-flattened plain
 * text the app has always had (`main/jira/jiraMap.ts`'s `adfToPlainText`).
 * Falling back to the plain text rather than rendering nothing is
 * deliberate: a body whose ADF is missing, or whose node types this renderer
 * does not yet cover, must still show its content. Losing formatting is a
 * degradation; losing the text is a bug — so every unhandled node type below
 * still emits its own text rather than being dropped, and a document that
 * isn't recognizably ADF at all (null, `{}`, a stray array) falls back to
 * `fallback` wholesale.
 *
 * Deliberately rendering-only: this does not attempt ADF <- text
 * serialization (that direction is a separate, harder piece of work), and it
 * never uses `dangerouslySetInnerHTML` — every node becomes real React
 * elements, and every link `href` is scheme-checked before it can become a
 * clickable `<a>` (see `safeHref` below).
 */
export function JiraRichText({
  adf,
  fallback,
  className,
}: {
  adf: unknown | null;
  fallback: string;
  className?: string;
}) {
  const rendered = renderAdfDocument(adf);
  if (rendered === null) {
    return (
      <div
        className={clsx(
          'text-[13px] leading-relaxed whitespace-pre-wrap text-text-secondary',
          className,
        )}
      >
        {fallback}
      </div>
    );
  }
  return <div className={className}>{rendered}</div>;
}

// -----------------------------------------------------------------------
// Link safety
// -----------------------------------------------------------------------

const ALLOWED_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * `href` is content authored by anyone with access to the user's Jira, not
 * this app — a `javascript:` or `data:` URL pasted (or crafted) into a link
 * mark must never reach a real `<a href>`. Resolving against a dummy base
 * lets a genuinely relative Jira-internal link ("/browse/ENG-1") through
 * (its inherited scheme is the harmless `https:` of the base) while still
 * rejecting an explicit dangerous scheme, which is the only thing this needs
 * to catch: Jira links in practice are always absolute anyway.
 */
function safeHref(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = new URL(raw, 'https://example.invalid');
    return ALLOWED_LINK_SCHEMES.has(parsed.protocol) ? raw : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------
// Fallback text extraction for a node type this renderer does not handle
// -----------------------------------------------------------------------

/**
 * A minimal, local text walk — deliberately not a reuse of
 * `main/jira/jiraMap.ts`'s `adfToPlainText` (that lives in the main process
 * and this is renderer code; the two sides of that boundary don't import
 * each other). This one is not trying to be a full flattener: the document's
 * own already-flattened text already reaches the caller as `fallback` for a
 * document-level failure. This is only the safety net for a node type deep
 * inside an otherwise-recognized document — enough to keep its words on
 * screen, not the canonical flatten.
 */
function extractPlainText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractPlainText).join('');
  if (typeof node !== 'object') return '';
  const record = node as Record<string, unknown>;
  if (record.type === 'text' && typeof record.text === 'string')
    return record.text;
  const attrs = record.attrs as Record<string, unknown> | undefined;
  if (typeof attrs?.text === 'string') return attrs.text;
  return extractPlainText(record.content);
}

// -----------------------------------------------------------------------
// Inline date attribute -> calendar day
// -----------------------------------------------------------------------

const MAX_TIMESTAMP_MS = 8.64e15;
const SECONDS_EPOCH_CEILING = 1e11;

/** Same magnitude/range reasoning as `jiraMap.ts`'s own `dateText`, kept as a
 * small independent copy for the same cross-process-boundary reason as
 * `extractPlainText` above. */
function formatAdfDate(rawTimestamp: unknown): string {
  if (typeof rawTimestamp !== 'string') return '';
  const raw = rawTimestamp.trim();
  if (!/^-?\d+$/.test(raw)) return '';
  const parsed = Number(raw);
  if (Math.abs(parsed) > MAX_TIMESTAMP_MS) return '';
  const timestamp =
    Math.abs(parsed) < SECONDS_EPOCH_CEILING ? parsed * 1000 : parsed;
  if (Math.abs(timestamp) > MAX_TIMESTAMP_MS) return '';
  const iso = new Date(timestamp).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) return '';
  return iso.slice(0, 10);
}

// -----------------------------------------------------------------------
// Marks
// -----------------------------------------------------------------------

function applyMarks(text: string, marks: unknown, key: string): ReactNode {
  if (!Array.isArray(marks) || marks.length === 0) return text;
  let node: ReactNode = text;
  marks.forEach((mark, i) => {
    if (!mark || typeof mark !== 'object') return;
    const m = mark as { type?: unknown; attrs?: Record<string, unknown> };
    const markKey = `${key}-m${i}`;
    switch (m.type) {
      case 'strong':
        node = <strong key={markKey}>{node}</strong>;
        break;
      case 'em':
        node = <em key={markKey}>{node}</em>;
        break;
      case 'strike':
        node = <s key={markKey}>{node}</s>;
        break;
      case 'underline':
        node = <u key={markKey}>{node}</u>;
        break;
      case 'code':
        node = (
          <code
            key={markKey}
            className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em] text-text"
          >
            {node}
          </code>
        );
        break;
      case 'link': {
        const href = safeHref(m.attrs?.href);
        // No href survives the scheme check -> the text itself is still
        // shown, just not as a link. Dropping the whole run here is exactly
        // the content loss this component exists to avoid.
        if (href) {
          node = (
            <a
              key={markKey}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-jira underline underline-offset-2 hover:no-underline"
            >
              {node}
            </a>
          );
        }
        break;
      }
      default:
        // subsup, textColor, backgroundColor, and any future mark: the text
        // itself already carries through unstyled, which is the honest
        // fallback for a mark this component doesn't render.
        break;
    }
  });
  return node;
}

// -----------------------------------------------------------------------
// Panels
// -----------------------------------------------------------------------

const PANEL_META: Record<string, { box: string; Icon: typeof Info }> = {
  info: { box: 'border-info/30 bg-info-bg', Icon: Info },
  note: { box: 'border-border-strong bg-surface-2', Icon: StickyNote },
  warning: { box: 'border-warning/30 bg-warning-bg', Icon: AlertTriangle },
  success: { box: 'border-success/30 bg-success-bg', Icon: CheckCircle2 },
  error: { box: 'border-danger/30 bg-danger-bg', Icon: XCircle },
};

function renderPanel(
  attrs: Record<string, unknown>,
  content: unknown,
  key: string,
): ReactNode {
  const panelType =
    typeof attrs.panelType === 'string' ? attrs.panelType : 'info';
  const meta = PANEL_META[panelType] ?? PANEL_META.info;
  const { Icon } = meta;
  return (
    <div
      key={key}
      className={clsx(
        'mb-2 flex gap-2 rounded-[var(--radius-sm)] border px-3 py-2',
        meta.box,
      )}
    >
      <Icon
        aria-hidden="true"
        size={15}
        className="mt-0.5 shrink-0 text-text-muted"
      />
      <div className="min-w-0 flex-1">{renderNode(content, key)}</div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Cards (pasted Jira/Confluence links, and generic embeds)
// -----------------------------------------------------------------------

/** A card's visible text: `data` OR `url`, never both, per Atlassian — same
 * shape `jiraMap.ts`'s `cardText` reads for the plain-text fallback. */
function cardHrefAndLabel(attrs: Record<string, unknown>): {
  href: string | null;
  label: string;
} {
  const directUrl = typeof attrs.url === 'string' ? attrs.url : '';
  const { data } = attrs;
  let dataUrl = '';
  let dataName = '';
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    dataUrl = typeof d.url === 'string' ? d.url : '';
    dataName = typeof d.name === 'string' ? d.name : '';
  }
  const rawUrl = directUrl || dataUrl;
  const label = rawUrl || dataName || 'Linked item';
  return { href: safeHref(rawUrl), label };
}

function renderCard(
  type: 'inlineCard' | 'blockCard' | 'embedCard',
  attrs: Record<string, unknown>,
  key: string,
): ReactNode {
  const { href, label } = cardHrefAndLabel(attrs);
  const body = href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-jira underline underline-offset-2 hover:no-underline"
    >
      {label}
    </a>
  ) : (
    <span>{label}</span>
  );
  if (type === 'inlineCard') return <span key={key}>{body}</span>;
  return (
    <div
      key={key}
      className="mb-2 rounded-[var(--radius-sm)] border border-border bg-bg-inset px-3 py-2 text-[12.5px]"
    >
      {body}
    </div>
  );
}

// -----------------------------------------------------------------------
// Media (images, files)
// -----------------------------------------------------------------------

/**
 * A Jira attachment's bytes live behind an authenticated Jira endpoint (the
 * same one `downloadJiraAttachment` in `data/jiraApi.ts` hits deliberately
 * through main, not a plain `<img src>`). This renders in the renderer
 * process with no way to attach that auth to an inline image request, so an
 * `<img>` here would just render broken. A labelled placeholder says what's
 * missing instead — the alt text (the one thing ADF carries inline) is
 * always shown when present, matching `jiraMap.ts`'s own plain-text media
 * handling.
 */
function renderMediaPlaceholder(
  type: 'media' | 'mediaInline',
  attrs: Record<string, unknown>,
  key: string,
): ReactNode {
  const alt = typeof attrs.alt === 'string' ? attrs.alt : '';
  const box = (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-[var(--radius-sm)] border border-dashed border-border-strong bg-surface-2 px-2 py-1 text-[11.5px] text-text-muted">
      <ImageOff aria-hidden="true" size={13} className="shrink-0" />
      <span className="truncate">
        {alt ? `${alt} — ` : ''}open in Jira to view
      </span>
    </span>
  );
  if (type === 'mediaInline') return <span key={key}>{box}</span>;
  return (
    <div key={key} className="mb-2">
      {box}
    </div>
  );
}

// -----------------------------------------------------------------------
// Headings
// -----------------------------------------------------------------------

const HEADING_SIZE: Record<number, string> = {
  1: 'text-[19px]',
  2: 'text-[17px]',
  3: 'text-[15px]',
  4: 'text-[14px]',
  5: 'text-[13px]',
  6: 'text-[13px]',
};

// -----------------------------------------------------------------------
// Node walk
// -----------------------------------------------------------------------

function renderNode(node: unknown, key: string): ReactNode {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (Array.isArray(node))
    return node.map((child, i) => renderNode(child, `${key}-${i}`));
  if (typeof node !== 'object') return null;

  const record = node as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  const attrs = (record.attrs ?? {}) as Record<string, unknown>;
  const { content } = record;

  switch (type) {
    case 'doc':
      return renderNode(content, key);

    case 'text':
      return applyMarks(
        typeof record.text === 'string' ? record.text : '',
        record.marks,
        key,
      );

    case 'hardBreak':
      return <br key={key} />;

    case 'paragraph':
      return (
        <p
          key={key}
          className="mb-2 text-[13px] leading-relaxed text-text-secondary last:mb-0"
        >
          {renderNode(content, key)}
        </p>
      );

    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(attrs.level) || 1));
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return (
        <Tag
          key={key}
          className={clsx(
            'mt-4 mb-2 font-display font-semibold text-text first:mt-0',
            HEADING_SIZE[level],
          )}
        >
          {renderNode(content, key)}
        </Tag>
      );
    }

    case 'bulletList':
      return (
        <ul
          key={key}
          className="mb-2 ml-5 list-disc space-y-1 text-[13px] leading-relaxed text-text-secondary"
        >
          {renderNode(content, key)}
        </ul>
      );

    case 'orderedList':
      return (
        <ol
          key={key}
          className="mb-2 ml-5 list-decimal space-y-1 text-[13px] leading-relaxed text-text-secondary"
        >
          {renderNode(content, key)}
        </ol>
      );

    case 'listItem':
      return <li key={key}>{renderNode(content, key)}</li>;

    case 'taskList':
    case 'decisionList':
      return (
        <ul
          key={key}
          className="mb-2 space-y-1 text-[13px] leading-relaxed text-text-secondary"
        >
          {renderNode(content, key)}
        </ul>
      );

    // Jira's editor emits `taskItem`; the node index documents
    // `blockTaskItem` — jiraMap.ts's own comment on ADF_BLOCK_TYPES notes
    // both spellings show up in practice, so both are handled here too.
    case 'taskItem':
    case 'blockTaskItem': {
      const done = attrs.state === 'DONE';
      const Icon = done ? CheckCircle2 : undefined;
      return (
        <li key={key} className="flex list-none items-start gap-2">
          {Icon ? (
            <Icon
              aria-hidden="true"
              size={14}
              className="mt-0.5 shrink-0 text-success"
            />
          ) : (
            <span
              aria-hidden="true"
              className="mt-1.5 size-3 shrink-0 rounded-sm border border-border-strong"
            />
          )}
          <span className={done ? 'text-text-muted line-through' : undefined}>
            {renderNode(content, key)}
          </span>
        </li>
      );
    }

    case 'decisionItem':
      return (
        <li key={key} className="list-none before:mr-1.5 before:content-['◆']">
          {renderNode(content, key)}
        </li>
      );

    case 'codeBlock': {
      const language = typeof attrs.language === 'string' ? attrs.language : '';
      return (
        <pre
          key={key}
          className="mb-2 overflow-x-auto rounded-[var(--radius-sm)] border border-border bg-bg-inset p-3 text-[12px] leading-relaxed"
        >
          <code
            className="font-mono text-text"
            data-language={language || undefined}
          >
            {renderNode(content, key)}
          </code>
        </pre>
      );
    }

    case 'blockquote':
      return (
        <blockquote
          key={key}
          className="mb-2 border-l-2 border-border-strong pl-3 text-[13px] leading-relaxed text-text-secondary italic"
        >
          {renderNode(content, key)}
        </blockquote>
      );

    case 'panel':
      return renderPanel(attrs, content, key);

    case 'rule':
      return <hr key={key} className="my-3 border-border" />;

    // Tables scroll inside their own container so a wide table never widens
    // the page itself.
    case 'table':
      return (
        <div
          key={key}
          className="mb-2 overflow-x-auto rounded-[var(--radius-sm)] border border-border"
        >
          <table className="w-full border-collapse text-[12.5px]">
            <tbody>{renderNode(content, key)}</tbody>
          </table>
        </div>
      );

    case 'tableRow':
      return (
        <tr key={key} className="border-b border-border last:border-b-0">
          {renderNode(content, key)}
        </tr>
      );

    case 'tableHeader':
      return (
        <th
          key={key}
          className="border-r border-border bg-surface-2 px-2 py-1.5 text-left font-semibold text-text last:border-r-0"
        >
          {renderNode(content, key)}
        </th>
      );

    case 'tableCell':
      return (
        <td
          key={key}
          className="border-r border-border px-2 py-1.5 align-top text-text-secondary last:border-r-0"
        >
          {renderNode(content, key)}
        </td>
      );

    case 'mention': {
      const label =
        typeof attrs.text === 'string' && attrs.text ? attrs.text : '@mention';
      return (
        <span
          key={key}
          className="rounded bg-jira-bg px-1 py-0.5 font-medium text-jira"
        >
          {label}
        </span>
      );
    }

    case 'emoji': {
      let label = '';
      if (typeof attrs.text === 'string') label = attrs.text;
      else if (typeof attrs.shortName === 'string') label = attrs.shortName;
      return label ? <span key={key}>{label}</span> : null;
    }

    case 'status': {
      const label = typeof attrs.text === 'string' ? attrs.text : '';
      return label ? (
        <span
          key={key}
          className="rounded-full border border-border-strong px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-text-secondary uppercase"
        >
          {label}
        </span>
      ) : null;
    }

    case 'date': {
      const label = formatAdfDate(attrs.timestamp);
      return label ? (
        <span key={key} className="font-medium text-text">
          {label}
        </span>
      ) : null;
    }

    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return renderCard(type, attrs, key);

    case 'mediaSingle':
    case 'mediaGroup':
      return (
        <div key={key} className="mb-2 flex flex-wrap gap-2">
          {renderNode(content, key)}
        </div>
      );

    case 'media':
    case 'mediaInline':
      return renderMediaPlaceholder(type, attrs, key);

    case 'expand':
    case 'nestedExpand': {
      const title =
        typeof attrs.title === 'string' && attrs.title
          ? attrs.title
          : 'Details';
      return (
        <details
          key={key}
          className="mb-2 rounded-[var(--radius-sm)] border border-border"
        >
          <summary className="cursor-pointer px-3 py-2 text-[12.5px] font-semibold text-text select-none">
            {title}
          </summary>
          <div className="px-3 pb-3">{renderNode(content, key)}</div>
        </details>
      );
    }

    default: {
      // Whitelist floor: any node type not handled above still surfaces its
      // own text rather than vanishing. A plain <span> is the safe default
      // shape — it never breaks a surrounding <tr>/<ul> the way a <div>
      // would if an unknown type ever showed up inside one.
      const text = extractPlainText(record);
      return text ? <span key={key}>{text}</span> : null;
    }
  }
}

// -----------------------------------------------------------------------
// Document entry point
// -----------------------------------------------------------------------

/**
 * `null` means "not recognizable as an ADF document" — null/undefined,
 * `{}`, a bare array, anything without a `content` array — and tells the
 * caller to render `fallback` instead. Anything else, including a document
 * whose `content` is `[]`, is treated as successfully rendered (possibly to
 * nothing, which matches an equally empty `fallback`).
 */
function renderAdfDocument(adf: unknown): ReactNode | null {
  if (adf == null || typeof adf !== 'object' || Array.isArray(adf)) return null;
  const { content } = adf as Record<string, unknown>;
  if (!Array.isArray(content)) return null;
  return content.map((child, i) => renderNode(child, `n-${i}`));
}
