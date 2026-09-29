import '@testing-library/jest-dom';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MARKDOWN_SYNTAX_HINTS } from '@/lib/markdown';
import { MarkdownEditor, type MarkdownEditorProps } from './MarkdownEditor';

function Controlled(props: Partial<MarkdownEditorProps> & { initial?: string }) {
  const [value, setValue] = useState(props.initial ?? '');
  return (
    <MarkdownEditor
      {...props}
      value={props.value ?? value}
      onChange={(v) => {
        setValue(v);
        props.onChange?.(v);
      }}
    />
  );
}

function getTextarea(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('textarea not found');
  return el;
}

describe('MarkdownEditor', () => {
  it('renders Write/Preview tabs, a toolbar, and the textarea with a placeholder', () => {
    render(<Controlled placeholder="Say something…" />);
    expect(screen.getByRole('tab', { name: 'Write' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Say something…')).toBeInTheDocument();
  });

  it('Bold on an empty selection inserts an empty pair with the caret between', () => {
    const { container } = render(<Controlled />);
    const textarea = getTextarea(container);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Bold' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(textarea.value).toBe('****');
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(2);
  });

  it('Bold on a selection wraps exactly that text and keeps it selected', () => {
    const { container } = render(<Controlled initial="hello world" />);
    const textarea = getTextarea(container);
    textarea.setSelectionRange(0, 5);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Bold' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(textarea.value).toBe('**hello** world');
    expect(textarea.value.slice(textarea.selectionStart!, textarea.selectionEnd!)).toBe('hello');
  });

  it('Bullet list adds a bullet to the current line', () => {
    const { container } = render(<Controlled initial="milk" />);
    const textarea = getTextarea(container);
    textarea.setSelectionRange(4, 4);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Bullet list' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bullet list' }));
    expect(textarea.value).toBe('- milk');
  });

  it('Link with a selection wraps it and selects the url placeholder', () => {
    const { container } = render(<Controlled initial="see docs" />);
    const textarea = getTextarea(container);
    textarea.setSelectionRange(4, 8);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(textarea.value).toBe('see [docs](url)');
    expect(textarea.value.slice(textarea.selectionStart!, textarea.selectionEnd!)).toBe('url');
  });

  it('a toolbar button does not steal focus (mousedown is prevented)', () => {
    render(<Controlled />);
    const bold = screen.getByRole('button', { name: 'Bold' });
    const notPrevented = fireEvent.mouseDown(bold);
    // fireEvent returns false when the event's preventDefault() was called.
    expect(notPrevented).toBe(false);
  });

  it('Cmd+Enter calls onSubmit and does not insert a newline', () => {
    const onSubmit = jest.fn();
    const { container } = render(<Controlled onSubmit={onSubmit} />);
    const textarea = getTextarea(container);
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Escape calls onCancel', () => {
    const onCancel = jest.fn();
    const { container } = render(<Controlled onCancel={onCancel} />);
    fireEvent.keyDown(getTextarea(container), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Enter continues a bullet list, and exits it from an empty item', () => {
    const { container } = render(<Controlled initial="- one" />);
    const textarea = getTextarea(container);
    textarea.setSelectionRange(5, 5);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('- one\n- ');

    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('- one\n');
  });

  it('pasting an image calls onFiles and does not insert clipboard text', () => {
    const onFiles = jest.fn();
    const { container } = render(<Controlled onFiles={onFiles} />);
    const textarea = getTextarea(container);
    const file = new File(['bytes'], 'screenshot.png', { type: 'image/png' });
    fireEvent.paste(textarea, { clipboardData: { files: [file], getData: () => '' } });
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(textarea.value).toBe('');
  });

  it('dropping a file calls onFiles and shows a drop-target state while dragging over', () => {
    const onFiles = jest.fn();
    const { container } = render(<Controlled onFiles={onFiles} />);
    const dropZone = container.querySelector('.relative.min-w-0') as HTMLElement;
    const file = new File(['a'], 'diagram.png', { type: 'image/png' });
    const dataTransfer = { types: ['Files'], files: [file] };

    fireEvent.dragEnter(dropZone, { dataTransfer });
    expect(screen.getByText('Drop to attach')).toBeInTheDocument();

    fireEvent.drop(dropZone, { dataTransfer });
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(screen.queryByText('Drop to attach')).not.toBeInTheDocument();
  });

  it('an ordinary text drag does not trigger the drop-target visual', () => {
    render(<Controlled onFiles={jest.fn()} />);
    const dropZone = screen.getByPlaceholderText('Write a comment…').parentElement as HTMLElement;
    fireEvent.dragEnter(dropZone, { dataTransfer: { types: ['text/plain'], files: [] } });
    expect(screen.queryByText('Drop to attach')).not.toBeInTheDocument();
  });

  it('does not render an attach button without an onFiles handler', () => {
    render(<Controlled />);
    expect(screen.queryByRole('button', { name: 'Attach file' })).not.toBeInTheDocument();
  });

  it('clicking Attach opens the native file picker and forwards picked files', () => {
    const onFiles = jest.fn();
    const { container } = render(<Controlled onFiles={onFiles} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['a'], 'notes.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('Preview renders the same escape-first markdown renderer a posted comment uses', () => {
    render(<Controlled initial="**bold** and a [link](https://example.com)" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    const preview = document.querySelector('.copilot-md') as HTMLElement;
    expect(preview.querySelector('strong')).toHaveTextContent('bold');
    expect(preview.querySelector('a')).toHaveAttribute('href', 'https://example.com');
  });

  it('Preview shows an honest empty state for an empty draft', () => {
    render(<Controlled initial="" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByText('Nothing to preview yet.')).toBeInTheDocument();
  });

  it('renders the caller-supplied footer actions', () => {
    render(<Controlled footerActions={<button type="button">Comment</button>} />);
    expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument();
  });

  it('disables the textarea and every toolbar button when disabled', () => {
    const { container } = render(<Controlled disabled />);
    expect(getTextarea(container)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Bold' })).toBeDisabled();
  });

  it('the "@" mention popup looks up matches and inserts the pick as plain text', async () => {
    const mentionSource = jest.fn().mockResolvedValue([{ id: 'u1', name: 'Alice' }]);
    const { container } = render(<Controlled mentionSource={mentionSource} />);
    const textarea = getTextarea(container);
    // Simulates typing "hey @al": a real keystroke changes both the value
    // and the caret in one native event, which is what handleChange reads.
    fireEvent.change(textarea, { target: { value: 'hey @al', selectionStart: 7, selectionEnd: 7 } });

    await waitFor(() => expect(mentionSource).toHaveBeenCalledWith('al'));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Alice' })).toBeInTheDocument());

    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(textarea.value).toBe('hey @Alice '));
    expect(screen.queryByRole('listbox', { name: 'Mention someone' })).not.toBeInTheDocument();
  });

  it('does not open a mention popup without a mentionSource', async () => {
    const { container } = render(<Controlled />);
    const textarea = getTextarea(container);
    fireEvent.change(textarea, { target: { value: 'hey @al', selectionStart: 7, selectionEnd: 7 } });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('listbox', { name: 'Mention someone' })).not.toBeInTheDocument();
  });

  it('the emoji picker filters by name and inserts the picked character', () => {
    const { container } = render(<Controlled />);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Emoji' }));
    fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
    fireEvent.change(screen.getByPlaceholderText('Search emoji…'), { target: { value: 'grin' } });
    fireEvent.click(screen.getByTitle('grinning'));
    const textarea = getTextarea(container);
    expect(textarea.value).toBe('😀');
  });

  it('the Markdown tips disclosure lists exactly what the renderer declares it supports', () => {
    render(<Controlled />);
    fireEvent.click(screen.getByRole('button', { name: 'Markdown tips' }));

    // The invariant is "derived from the renderer", not a snapshot of one
    // particular feature set. An earlier version of this test asserted the
    // opposite of what is now true — that blockquotes and task lists must
    // be ABSENT, because renderMarkdown could not do them — and would have
    // gone on passing after the renderer learned both, quietly pinning the
    // tips list to an out-of-date promise. Asserting against the
    // renderer's own exported declaration is the version that cannot rot:
    // add support, add a hint, and this keeps passing for the right
    // reason.
    // Labels are matched as elements; the syntax column is matched against
    // the panel's raw text instead, because at least one hint (the fenced
    // code block) is genuinely multi-line and getByText normalizes
    // whitespace, which would make it unfindable no matter how it renders.
    const panel = screen.getByText('Blockquote').closest('dl') as HTMLElement;
    MARKDOWN_SYNTAX_HINTS.forEach((hint) => {
      expect(screen.getByText(hint.label)).toBeInTheDocument();
      expect(panel.textContent ?? '').toContain(hint.syntax);
    });

    // And the two that regression specifically concerned, now that
    // renderMarkdown genuinely renders them.
    expect(screen.getByText(/blockquote/i)).toBeInTheDocument();
    expect(screen.getByText(/task list/i)).toBeInTheDocument();
  });
});
