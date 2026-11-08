import { describe, expect, it } from 'vitest';
import { commonsSrcSet } from './commons-thumbnail';

describe('commonsSrcSet', () => {
  it('offers the standard widths below the stored 960 px copy, by rewriting the width segment', () => {
    const url = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3e/MNAA.jpg/960px-MNAA.jpg?utm_source=commons.wikimedia.org';
    expect(commonsSrcSet(url)).toBe(
      [
        'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3e/MNAA.jpg/330px-MNAA.jpg?utm_source=commons.wikimedia.org 330w',
        'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3e/MNAA.jpg/500px-MNAA.jpg?utm_source=commons.wikimedia.org 500w',
        `${url} 960w`,
      ].join(', '),
    );
  });

  it('rewrites only the final width segment, even when the file name contains one', () => {
    const url = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/960px-old.jpg/960px-960px-old.jpg';
    expect(commonsSrcSet(url)?.split(', ')[0]).toBe('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/960px-old.jpg/330px-960px-old.jpg 330w');
  });

  it('keeps percent-encoded names intact', () => {
    const url = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d3/011499_-_Lisboa_%2821691724913%29.jpg/960px-011499_-_Lisboa_%2821691724913%29.jpg';
    expect(commonsSrcSet(url)).toContain('/330px-011499_-_Lisboa_%2821691724913%29.jpg 330w');
  });

  it('never offers a width at or above the stored one', () => {
    expect(commonsSrcSet('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/500px-X.jpg')).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/330px-X.jpg 330w, https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/500px-X.jpg 500w',
    );
    expect(commonsSrcSet('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/330px-X.jpg')).toBeNull();
  });

  it('leaves anything that is not a Commons thumbnail alone', () => {
    expect(commonsSrcSet('https://upload.wikimedia.org/wikipedia/commons/a/ab/Original.jpg')).toBeNull();
    expect(commonsSrcSet('https://example.org/thumb/a/ab/X.jpg/960px-X.jpg')).toBeNull();
    expect(commonsSrcSet('http://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/960px-X.jpg')).toBeNull();
    expect(commonsSrcSet('/api/place-photo?ref=1')).toBeNull();
  });
});
