import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { CAPABILITIES } from '@/capabilities';
import { NotWired } from './NotWired';

describe('NotWired', () => {
  it("renders the register's own note, verbatim — not prose invented at the call site", () => {
    render(<NotWired capability="webhooks.delivery" />);

    expect(
      screen.getByText(CAPABILITIES['webhooks.delivery'].note!),
    ).toBeInTheDocument();
  });

  it('renders a different note for a different capability, still pulled from the register', () => {
    render(<NotWired capability="tickets.drafts" />);

    expect(
      screen.getByText(CAPABILITIES['tickets.drafts'].note!),
    ).toBeInTheDocument();
  });

  it('rejects a key that is not in CAPABILITIES at compile time, and blows up loudly if bypassed', () => {
    expect(() => {
      // @ts-expect-error — 'not.a.real.capability' is not a CapabilityKey.
      render(<NotWired capability="not.a.real.capability" />);
    }).toThrow();
  });

  it('has no `note` prop to call it with — the register is the only source of copy', () => {
    render(
      // @ts-expect-error — NotWired takes only `capability`, never ad-hoc `note` prose.
      <NotWired capability="webhooks.delivery" note="Something I made up" />,
    );

    // A `note` prop is a type error above; confirm it is also inert at
    // runtime — the invented text never renders, the registered one still does.
    expect(screen.queryByText('Something I made up')).not.toBeInTheDocument();
    expect(
      screen.getByText(CAPABILITIES['webhooks.delivery'].note!),
    ).toBeInTheDocument();
  });
});
