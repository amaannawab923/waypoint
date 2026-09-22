import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  clearSessionDraft,
  DRAFT_PREFIX,
  DRAFT_WRITE_MS,
  readSessionDraft,
  SessionComposer,
} from './SessionComposer';

describe('SessionComposer', () => {
  it('sends the trimmed text on Enter and clears; Shift+Enter and a composing Enter stay newlines', async () => {
    const onSend = jest.fn(async () => {});
    render(
      <SessionComposer
        onSend={onSend}
        sendBlockedReason={null}
        attachedToBand={false}
      />,
    );
    const box = screen.getByLabelText('Message this session');
    fireEvent.change(box, { target: { value: '  Run the tests  ' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(onSend).toHaveBeenCalledWith('Run the tests');
    expect(box).toHaveValue('');
  });

  it('still sends on ⌘Enter and Ctrl+Enter', async () => {
    const onSend = jest.fn<Promise<void>, [string]>(async () => {});
    render(
      <SessionComposer
        onSend={onSend}
        sendBlockedReason={null}
        attachedToBand={false}
      />,
    );
    const box = screen.getByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'one' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    });
    fireEvent.change(box, { target: { value: 'two' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    });
    expect(onSend.mock.calls.map((c) => c[0])).toEqual(['one', 'two']);
  });

  it('keeps the text when sending fails, and never sends blank text', async () => {
    const onSend = jest.fn(async () => {
      throw new Error('no session');
    });
    render(
      <SessionComposer
        onSend={onSend}
        sendBlockedReason={null}
        attachedToBand={false}
      />,
    );
    const box = screen.getByLabelText('Message this session');
    fireEvent.click(screen.getByLabelText('Send'));
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: 'hello' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(box).toHaveValue('hello');
  });

  it('never disables the box: with Send held back (engine down) the text is still typed and kept, and only the button is off', () => {
    render(
      <SessionComposer
        draftKey="run-blocked"
        onSend={jest.fn()}
        sendBlockedReason="The agent engine is not running — your message is kept here until it is."
        attachedToBand={false}
      />,
    );
    const box = screen.getByLabelText('Message this session');
    expect(box).not.toBeDisabled();
    expect(box).not.toHaveAttribute('readonly');
    expect(box).toHaveAttribute(
      'placeholder',
      'The agent engine is not running — your message is kept here until it is.',
    );
    fireEvent.change(box, { target: { value: 'while you were out' } });
    expect(box).toHaveValue('while you were out');
    expect(screen.getByLabelText('Send')).toBeDisabled();
  });

  it('is never rendered disabled under any prop combination (never-lock)', () => {
    [null, 'engine down'].forEach((sendBlockedReason) => {
      [false, true].forEach((attachedToBand) => {
        const { unmount } = render(
          <SessionComposer
            onSend={jest.fn()}
            sendBlockedReason={sendBlockedReason}
            attachedToBand={attachedToBand}
            placeholder="anything"
          />,
        );
        expect(
          screen.getByLabelText('Message this session'),
        ).not.toBeDisabled();
        unmount();
      });
    });
  });

  it('empties the box the moment a send starts, and puts the text back — ahead of anything typed since — when it did not land', async () => {
    let settle: (ok: boolean) => void = () => {};
    const onSend = jest.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          settle = (ok) => (ok ? resolve() : reject(new Error('not sent')));
        }),
    );
    render(
      <SessionComposer
        onSend={onSend}
        sendBlockedReason={null}
        attachedToBand={false}
      />,
    );
    const box = screen.getByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'first' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    });
    expect(box).toHaveValue('');
    expect(box).not.toBeDisabled();
    fireEvent.change(box, { target: { value: 'second' } });
    await act(async () => {
      settle(false);
    });
    expect(box).toHaveValue('first\nsecond');
  });

  describe('draft per run (W4, ROAD-68)', () => {
    beforeEach(() => {
      window.localStorage.clear();
      jest.useFakeTimers();
    });
    afterEach(() => jest.useRealTimers());

    it('restores the run’s draft on mount, writes it after a pause, and drops it on send', async () => {
      window.localStorage.setItem(`${DRAFT_PREFIX}run-a`, 'half a thought');
      const onSend = jest.fn(async () => {});
      render(
        <SessionComposer
          draftKey="run-a"
          onSend={onSend}
          sendBlockedReason={null}
          attachedToBand={false}
        />,
      );
      const box = screen.getByLabelText('Message this session');
      expect(box).toHaveValue('half a thought');

      fireEvent.change(box, { target: { value: 'half a thought, finished' } });
      expect(readSessionDraft('run-a')).toBe('half a thought');
      act(() => {
        jest.advanceTimersByTime(DRAFT_WRITE_MS);
      });
      expect(readSessionDraft('run-a')).toBe('half a thought, finished');

      await act(async () => {
        fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
      });
      expect(onSend).toHaveBeenCalledWith('half a thought, finished');
      expect(readSessionDraft('run-a')).toBe('');
    });

    it('flushes the draft when unmounted mid-pause, and one run’s draft is not another’s', () => {
      const { unmount } = render(
        <SessionComposer
          draftKey="run-b"
          onSend={jest.fn(async () => {})}
          sendBlockedReason={null}
          attachedToBand={false}
        />,
      );
      fireEvent.change(screen.getByLabelText('Message this session'), {
        target: { value: 'switching away' },
      });
      unmount();
      expect(readSessionDraft('run-b')).toBe('switching away');
      expect(readSessionDraft('run-a')).toBe('');
      clearSessionDraft('run-b');
      expect(readSessionDraft('run-b')).toBe('');
    });

    // Found in review, round 4: the composer is mounted per run, so a
    // person who switched runs while a send was in flight had already
    // unmounted it by the time the send failed — the catch's setText was
    // dropped by React, the draft effect never ran, and the message was
    // simply gone, toast or no toast.
    it('a send that fails after the person has switched away still puts the text back in the run’s draft', async () => {
      let settle: (ok: boolean) => void = () => {};
      const onSend = jest.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            settle = (ok) => (ok ? resolve() : reject(new Error('not sent')));
          }),
      );
      const { unmount } = render(
        <SessionComposer
          draftKey="run-c"
          onSend={onSend}
          sendBlockedReason={null}
          attachedToBand={false}
        />,
      );
      const box = screen.getByLabelText('Message this session');
      fireEvent.change(box, { target: { value: 'the message' } });
      await act(async () => {
        fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
      });
      expect(readSessionDraft('run-c')).toBe('');
      unmount();
      await act(async () => {
        settle(false);
      });
      expect(readSessionDraft('run-c')).toBe('the message');
      clearSessionDraft('run-c');
    });

    // Round 5 of review: the fix above wrote the recovered text to storage
    // — but a person who switched away and BACK had a fresh composer for
    // the same run by then, typing, and its next debounced draft write
    // overwrote storage with its own text: the recovered message was gone
    // again. A recovery now goes to the mounted composer when there is
    // one, so it lands in the box, ahead of what was typed since.
    it('a send that fails after the person switched away and back lands in the new composer, ahead of what they typed since', async () => {
      let settle: (ok: boolean) => void = () => {};
      const onSend = jest.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            settle = (ok) => (ok ? resolve() : reject(new Error('not sent')));
          }),
      );
      const first = render(
        <SessionComposer
          draftKey="run-d"
          onSend={onSend}
          sendBlockedReason={null}
          attachedToBand={false}
        />,
      );
      const box = screen.getByLabelText('Message this session');
      fireEvent.change(box, { target: { value: 'the message' } });
      await act(async () => {
        fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
      });
      first.unmount();

      // Back to the same run: a fresh composer, typing.
      render(
        <SessionComposer
          draftKey="run-d"
          onSend={jest.fn(async () => {})}
          sendBlockedReason={null}
          attachedToBand={false}
        />,
      );
      const again = screen.getByLabelText('Message this session');
      fireEvent.change(again, { target: { value: 'hi' } });
      await act(async () => {
        settle(false);
      });
      expect(again).toHaveValue('the message\nhi');
      // And the next debounced write keeps it.
      act(() => {
        jest.advanceTimersByTime(DRAFT_WRITE_MS);
      });
      expect(readSessionDraft('run-d')).toBe('the message\nhi');
      clearSessionDraft('run-d');
    });
  });

  describe('the controls under the box', () => {
    const config = {
      modelOptions: {
        configId: 'model',
        selected: 'claude-opus-5',
        available: [
          { id: 'claude-opus-5', name: 'Claude Opus 5' },
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
        ],
      },
      efforts: null,
      modeOptions: {
        configId: 'mode',
        selected: 'bypassPermissions',
        available: [
          { id: 'default', name: 'Ask before acting' },
          { id: 'bypassPermissions', name: 'Auto-approve' },
        ],
      },
      availableCommands: [],
    };

    it('shows the mode and model the session offers, and hands a change to the setter', () => {
      const onSetMode = jest.fn();
      const onSetModel = jest.fn();
      render(
        <SessionComposer
          onSend={jest.fn(async () => {})}
          sendBlockedReason={null}
          attachedToBand={false}
          config={config}
          onSetMode={onSetMode}
          onSetModel={onSetModel}
        />,
      );
      // No plan mode offered: the provider's own list, nothing simpler.
      expect(screen.queryByRole('group', { name: 'Mode' })).toBeNull();
      const mode = screen.getByLabelText('All modes');
      expect(mode).toHaveValue('bypassPermissions');
      fireEvent.change(mode, { target: { value: 'default' } });
      expect(onSetMode).toHaveBeenCalledWith('default');
      const model = screen.getByLabelText('Model');
      expect(model).toHaveValue('claude-opus-5');
      fireEvent.change(model, { target: { value: 'claude-sonnet-5' } });
      expect(onSetModel).toHaveBeenCalledWith('claude-sonnet-5');
      // No effort offered: no effort selector.
      expect(screen.queryByLabelText('Effort')).toBeNull();
    });

    it('never hands the "—" placeholder (no selection yet) to a setter', () => {
      const onSetModel = jest.fn();
      render(
        <SessionComposer
          onSend={jest.fn(async () => {})}
          sendBlockedReason={null}
          attachedToBand={false}
          config={{
            ...config,
            modelOptions: { ...config.modelOptions, selected: null },
          }}
          onSetModel={onSetModel}
        />,
      );
      const model = screen.getByLabelText('Model');
      expect(model).toHaveValue('');
      fireEvent.change(model, { target: { value: '' } });
      expect(onSetModel).not.toHaveBeenCalled();
      fireEvent.change(model, { target: { value: 'claude-sonnet-5' } });
      expect(onSetModel).toHaveBeenCalledWith('claude-sonnet-5');
    });

    it('shows no selector before the config lands or when the provider offers none', () => {
      render(
        <SessionComposer
          onSend={jest.fn(async () => {})}
          sendBlockedReason={null}
          attachedToBand={false}
          config={null}
        />,
      );
      expect(screen.queryByLabelText('All modes')).toBeNull();
      expect(screen.queryByRole('group', { name: 'Mode' })).toBeNull();
      expect(screen.queryByLabelText('Model')).toBeNull();
    });

    // Customer feedback round 1, Fix 6: two positions a person can read
    // without knowing the provider's six names, the full list under
    // Advanced with each name glossed.
    describe('the two-way mode picker', () => {
      const claude = {
        ...config,
        modeOptions: {
          configId: 'mode',
          selected: 'default',
          available: [
            { id: 'default', name: 'Default' },
            { id: 'acceptEdits', name: 'Accept Edits' },
            { id: 'plan', name: 'Plan Mode' },
            { id: 'bypassPermissions', name: 'Bypass Permissions' },
            { id: 'auto', name: 'Auto', description: 'The provider says so.' },
            { id: 'dontAsk', name: "Don't Ask" },
          ],
        },
      };

      // S6 (PR #88 review): the write-side button used to say "May edit
      // files" no matter which mode it actually set — here, the run's
      // write mode is `bypassPermissions`, glossed "Never asks — edits,
      // runs commands, deletes without a prompt", with only the title
      // tooltip saying so. The button is now named for the mode itself.
      it('Read-only is plan; the write button is named for the run’s actual write mode', () => {
        const onSetMode = jest.fn();
        render(
          <SessionComposer
            onSend={jest.fn(async () => {})}
            sendBlockedReason={null}
            attachedToBand={false}
            config={{
              ...claude,
              // The session is actually running in the run's write mode
              // (matches writeModeId below) — the button should read
              // pressed for its own mode, not merely "any non-plan mode".
              modeOptions: {
                ...claude.modeOptions,
                selected: 'bypassPermissions',
              },
            }}
            writeModeId="bypassPermissions"
            onSetMode={onSetMode}
          />,
        );
        const readOnly = screen.getByRole('button', { name: 'Read-only' });
        const edit = screen.getByRole('button', { name: 'Bypass Permissions' });
        expect(readOnly).toHaveAttribute('aria-pressed', 'false');
        expect(edit).toHaveAttribute('aria-pressed', 'true');
        expect(readOnly).toHaveAttribute(
          'title',
          'Reads and reports. Changes nothing.',
        );
        expect(edit.getAttribute('title')).toMatch(/^Never asks/);
        fireEvent.click(readOnly);
        expect(onSetMode).toHaveBeenCalledWith('plan');
        fireEvent.click(edit);
        expect(onSetMode).toHaveBeenLastCalledWith('bypassPermissions');
        // The full list is folded away until asked for.
        expect(screen.queryByLabelText('All modes')).toBeNull();
      });

      // S6: a run already on a THIRD mode (acceptEdits) — not plan, not
      // the write mode the segment sets — used to show the write button
      // already pressed (aria-pressed was true for any non-plan mode),
      // so clicking it looked like a no-op while it silently escalated
      // straight to bypassPermissions. Now the button correctly shows
      // not-pressed (it does not represent the current mode) AND the
      // click itself is a no-op — never an escalation the person did not
      // ask for by name.
      it('a run already on a different non-plan mode: the write button shows unpressed and a click never escalates it', () => {
        const onSetMode = jest.fn();
        render(
          <SessionComposer
            onSend={jest.fn(async () => {})}
            sendBlockedReason={null}
            attachedToBand={false}
            config={{
              ...claude,
              modeOptions: { ...claude.modeOptions, selected: 'acceptEdits' },
            }}
            writeModeId="bypassPermissions"
            onSetMode={onSetMode}
          />,
        );
        const edit = screen.getByRole('button', {
          name: 'Bypass Permissions',
        });
        expect(edit).toHaveAttribute('aria-pressed', 'false');
        expect(edit.getAttribute('title')).toMatch(
          /^Currently Accept Edits\. Switch to Read-only first/,
        );
        fireEvent.click(edit);
        expect(onSetMode).not.toHaveBeenCalled();
        // Read-only itself is unaffected — still a real, working switch.
        fireEvent.click(screen.getByRole('button', { name: 'Read-only' }));
        expect(onSetMode).toHaveBeenCalledWith('plan');
      });

      it('Advanced opens the provider’s full list, each mode glossed — never a guessed one', () => {
        const onSetMode = jest.fn();
        render(
          <SessionComposer
            onSend={jest.fn(async () => {})}
            sendBlockedReason={null}
            attachedToBand={false}
            config={{
              ...claude,
              modeOptions: { ...claude.modeOptions, selected: 'plan' },
            }}
            writeModeId="default"
            onSetMode={onSetMode}
          />,
        );
        expect(
          screen.getByRole('button', { name: 'Read-only' }),
        ).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
        const all = screen.getByLabelText('All modes') as HTMLSelectElement;
        expect([...all.options].map((o) => o.text)).toEqual([
          'Default',
          'Accept Edits',
          'Plan Mode',
          'Bypass Permissions',
          'Auto',
          "Don't Ask",
        ]);
        const byValue = (id: string) =>
          [...all.options].find((o) => o.value === id)!;
        expect(byValue('acceptEdits').title).toBe(
          'Edits files without asking; still asks before running a command.',
        );
        // The provider's own description when Waypoint has no gloss; no
        // title at all when neither says anything.
        expect(byValue('auto').title).toBe('The provider says so.');
        expect(byValue('dontAsk').title).toBe('');
        fireEvent.change(all, { target: { value: 'acceptEdits' } });
        expect(onSetMode).toHaveBeenCalledWith('acceptEdits');
      });
    });

    it('is a Stop button while the agent is generating, and Send again after', () => {
      const onStop = jest.fn();
      const { rerender } = render(
        <SessionComposer
          onSend={jest.fn(async () => {})}
          sendBlockedReason={null}
          attachedToBand={false}
          generating
          onStop={onStop}
        />,
      );
      expect(screen.queryByLabelText('Send')).toBeNull();
      fireEvent.click(screen.getByLabelText('Stop'));
      expect(onStop).toHaveBeenCalledTimes(1);
      rerender(
        <SessionComposer
          onSend={jest.fn(async () => {})}
          sendBlockedReason={null}
          attachedToBand={false}
          generating={false}
          onStop={onStop}
        />,
      );
      expect(screen.queryByLabelText('Stop')).toBeNull();
      expect(screen.getByLabelText('Send')).toBeDisabled();
    });
  });
});
