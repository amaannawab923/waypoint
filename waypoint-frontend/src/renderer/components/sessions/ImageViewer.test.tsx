import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { ImageViewer, type ViewerImage } from './ImageViewer';

const images: ViewerImage[] = [
  { id: 'a:image:0', name: 'Image 1', dataUrl: 'data:image/png;base64,A' },
  { id: 'b:image:0', name: 'Image 2', dataUrl: 'data:image/png;base64,B' },
  { id: 'c:image:0', name: 'Image 3', dataUrl: 'data:image/png;base64,C' },
];

const shown = () =>
  (
    screen
      .getByRole('dialog')
      .querySelector('img[alt^="Image"]') as HTMLImageElement
  ).src;

describe('ImageViewer', () => {
  it('renders nothing until asked, then opens on the clicked image with a counter and a filmstrip', () => {
    const { rerender } = render(
      <ImageViewer images={images} initialId={null} onClose={jest.fn()} />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(
      <ImageViewer images={images} initialId="b:image:0" onClose={jest.fn()} />,
    );
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Image 2, 2 of 3');
    expect(shown()).toBe('data:image/png;base64,B');
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    const strip = screen
      .getByRole('dialog')
      .querySelector('[data-viewer-filmstrip]');
    expect(strip?.querySelectorAll('button')).toHaveLength(3);
    expect(screen.getByLabelText('Show Image 2')).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('moves with the arrows, the keyboard and the filmstrip, and stops at the ends', () => {
    render(
      <ImageViewer images={images} initialId="a:image:0" onClose={jest.fn()} />,
    );
    expect(shown()).toBe('data:image/png;base64,A');
    // First: previous is hidden.
    expect(screen.getByLabelText('Previous image')).toHaveClass('invisible');

    fireEvent.click(screen.getByLabelText('Next image'));
    expect(shown()).toBe('data:image/png;base64,B');
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(shown()).toBe('data:image/png;base64,C');
    // Last: next is hidden and the key does nothing.
    expect(screen.getByLabelText('Next image')).toHaveClass('invisible');
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(shown()).toBe('data:image/png;base64,C');

    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(shown()).toBe('data:image/png;base64,B');
    fireEvent.click(screen.getByLabelText('Show Image 1'));
    expect(shown()).toBe('data:image/png;base64,A');
  });

  it('one image: no counter, no arrows, no filmstrip', () => {
    render(
      <ImageViewer
        images={[images[0]]}
        initialId="a:image:0"
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Image 1');
    expect(screen.queryByText(/\/ 1/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Next image')).not.toBeInTheDocument();
    expect(
      screen.getByRole('dialog').querySelector('[data-viewer-filmstrip]'),
    ).toBeNull();
  });

  it('closes on Escape, on the close button, and on the backdrop — not on the image', () => {
    const onClose = jest.fn();
    render(
      <ImageViewer images={images} initialId="a:image:0" onClose={onClose} />,
    );
    fireEvent.click(
      screen.getByRole('dialog').querySelector('img[alt="Image 1"]')!,
    );
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByLabelText('Close'));
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('an initialId not in the list still opens, on the first image', () => {
    render(
      <ImageViewer images={images} initialId="nope" onClose={jest.fn()} />,
    );
    expect(shown()).toBe('data:image/png;base64,A');
  });
});
