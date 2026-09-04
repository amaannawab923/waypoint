'use strict';

/**
 * no-actionless-button
 *
 * Part of the "honesty" lint gate (see docs/design/waypoint-revamp-architecture.md
 * §7.3). Reports a `<Button>` element (the component exported from
 * `components/ui/Button`, resolved by import source so unrelated components
 * that happen to be named "Button" are not caught) that has no `onClick`, no
 * `type="submit"`, and no `href` — i.e. a button that renders as clickable but
 * cannot do anything when clicked.
 *
 * A `disabled` button is exempt: a disabled control paired with something like
 * `title="Coming soon"` is an honest "not yet" rather than a control that lies
 * about being live, which is the thing this rule exists to catch.
 *
 * A `<Button {...spread}>` is also exempt — spread props may carry `onClick`
 * (or `type`) that this rule cannot see without evaluating the spread source,
 * and guessing would trade a real false-negative risk for a worse
 * false-positive one.
 */

const BUTTON_IMPORT_SOURCE_RE = /\/Button(\.tsx?)?$/;

function isDisabledAttribute(attr) {
  const { value } = attr;
  if (value === null) return true; // bare `disabled`
  if (value.type === 'JSXExpressionContainer') {
    const expr = value.expression;
    // `disabled={false}` is the one expression form that is NOT disabled;
    // everything else (a variable, `disabled={true}`, an expression) is
    // treated as disabled since we cannot evaluate it statically and a
    // false positive here is worse than a missed one.
    return !(expr.type === 'Literal' && expr.value === false);
  }
  return true;
}

function isSubmitTypeAttribute(attr) {
  const { value } = attr;
  const literal =
    value && value.type === 'JSXExpressionContainer' ? value.expression : value;
  return !!literal && literal.type === 'Literal' && literal.value === 'submit';
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow <Button> elements with no onClick, type="submit", or href.',
    },
    schema: [],
    messages: {
      actionless:
        'This Button has no onClick, type="submit", or href, so clicking it does nothing. ' +
        'Wire it up, render <NotWired> from capabilities.ts, or delete it.',
    },
  },
  create(context) {
    let buttonLocalNames = new Set();

    return {
      Program(node) {
        buttonLocalNames = new Set();
        for (const statement of node.body) {
          if (statement.type !== 'ImportDeclaration') continue;
          if (
            typeof statement.source.value !== 'string' ||
            !BUTTON_IMPORT_SOURCE_RE.test(statement.source.value)
          ) {
            continue;
          }
          for (const specifier of statement.specifiers) {
            if (
              specifier.type === 'ImportSpecifier' &&
              specifier.imported.type === 'Identifier' &&
              specifier.imported.name === 'Button'
            ) {
              buttonLocalNames.add(specifier.local.name);
            }
          }
        }
      },

      JSXOpeningElement(node) {
        if (
          node.name.type !== 'JSXIdentifier' ||
          !buttonLocalNames.has(node.name.name)
        )
          return;

        let hasHandler = false;
        let isDisabled = false;
        let hasSpread = false;

        for (const attr of node.attributes) {
          if (attr.type === 'JSXSpreadAttribute') {
            hasSpread = true;
            continue;
          }
          if (attr.name.type !== 'JSXIdentifier') continue;

          const name = attr.name.name;
          if (name === 'onClick' || name === 'href') {
            hasHandler = true;
          } else if (name === 'type' && isSubmitTypeAttribute(attr)) {
            hasHandler = true;
          } else if (name === 'disabled' && isDisabledAttribute(attr)) {
            isDisabled = true;
          }
        }

        if (hasSpread || hasHandler || isDisabled) return;

        context.report({ node, messageId: 'actionless' });
      },
    };
  },
};
