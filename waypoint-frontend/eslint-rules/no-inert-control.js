'use strict';

/**
 * no-inert-control
 *
 * Part of the "honesty" lint gate (see docs/design/waypoint-revamp-architecture.md
 * §7.3). Reports a JSX `onClick`/`onSubmit`/`onChange` prop whose function body
 * contains no call expression other than `console.*`, a `useState`-style setter
 * call (`setSomething(...)`), or `close()`.
 *
 * Deliberately narrow, on three axes:
 *
 * 1. Only inline handlers are analyzed — `onClick={() => { ... }}` or
 *    `onClick={function () { ... }}` written directly on the prop. A handler
 *    passed by reference (`onClick={handleDelete}`, `onClick={toggle}`,
 *    `onClick={onClose}`) is not resolved to its declaration; resolving
 *    identifiers across scopes reliably is exactly the kind of cleverness that
 *    turns a narrow, low-noise rule into a noisy one. This means a fake handler
 *    extracted into a named function will not be caught — an accepted gap, not
 *    an oversight.
 * 2. A handler is only flagged when *every* call it makes (recursively, so
 *    calls nested inside callbacks/promises still count) is one of the three
 *    exempt kinds. A single non-exempt call anywhere in the body — a store
 *    action, an IPC/API call, a navigation, anything — is enough to prove the
 *    handler does something real, so the whole handler is left alone.
 * 3. Critically, the body must contain at least one `console.*` call to be
 *    flagged at all — a handler that *only* calls a setState setter and/or
 *    `close()`, with no logging, is not reported. That was not the original
 *    design (see the architecture doc, which also expects a setState-only
 *    handler to be caught) but running this rule against the current tree
 *    showed why it does not hold for inline handlers here: patterns like
 *    `onClick={() => setStep(2)}` (wizard navigation) and
 *    `onClick={() => close()}` (a plain Cancel/Close button) are common,
 *    legitimate, and indistinguishable from a fake handler by shape alone —
 *    treating "setState/close only" as inert produced ~150 hits, nearly all
 *    of them real UI logic. Requiring a `console.*` call keeps the rule
 *    anchored to the one shape that is unambiguously fake — nobody ships a
 *    real feature via `console.log` — at the cost of not catching a fake
 *    handler that was written without any logging at all. That gap is left
 *    to the capability register and code review (§7.1, §7.4), not this rule.
 */

const CONTROLLED_PROPS = new Set(['onClick', 'onSubmit', 'onChange']);

// Real timers, not useState setters — excluded from the "set*" heuristic below
// even though they match the naming shape.
const NOT_STATE_SETTERS = new Set([
  'setTimeout',
  'setInterval',
  'setImmediate',
]);

function isStateSetterName(name) {
  return /^set[A-Z0-9]/.test(name) && !NOT_STATE_SETTERS.has(name);
}

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier'
  ) {
    return callee.property.name;
  }
  return null;
}

function isConsoleCall(callExpression) {
  const { callee } = callExpression;
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'console'
  );
}

function isExemptCall(callExpression) {
  if (isConsoleCall(callExpression)) return true;

  const name = calleeName(callExpression.callee);
  if (!name) return false;

  // `close()` (render-prop pattern used by Dropdown/modal components) or
  // `something.close()` (a ref/handle's close method).
  if (name === 'close') return true;

  // A useState-style setter, e.g. `setOpen(true)`.
  if (isStateSetterName(name)) return true;

  return false;
}

// Manual recursive walk instead of relying on ESLint's own traversal, so we
// can collect every CallExpression under a single handler's body — including
// ones nested inside further callbacks — in one pass, scoped to just that body.
function collectCallExpressions(node, out) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'CallExpression') out.push(node);

  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item.type === 'string')
          collectCallExpressions(item, out);
      }
    } else if (value && typeof value.type === 'string') {
      collectCallExpressions(value, out);
    }
  }
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow JSX onClick/onSubmit/onChange handlers that do nothing but log, set local state, or close something.',
    },
    schema: [],
    messages: {
      inert:
        "This handler doesn't do anything real: it only calls console.*, a local setState setter, and/or close(). " +
        'Wire it up, render <NotWired> from capabilities.ts, or delete the control. ' +
        'If this is genuinely local-UI-only, suppress with a reason: ' +
        '// eslint-disable-next-line no-inert-control -- <reason>',
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (
          node.name.type !== 'JSXIdentifier' ||
          !CONTROLLED_PROPS.has(node.name.name)
        )
          return;

        const { value } = node;
        if (!value || value.type !== 'JSXExpressionContainer') return;

        const expr = value.expression;
        if (
          expr.type !== 'ArrowFunctionExpression' &&
          expr.type !== 'FunctionExpression'
        )
          return;

        const calls = [];
        collectCallExpressions(expr.body, calls);

        const hasConsoleCall = calls.some(isConsoleCall);
        if (!hasConsoleCall) return;

        const hasRealCall = calls.some((call) => !isExemptCall(call));
        if (hasRealCall) return;

        context.report({ node, messageId: 'inert' });
      },
    };
  },
};
