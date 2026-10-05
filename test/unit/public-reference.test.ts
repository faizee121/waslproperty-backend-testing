import { describe, expect, it, vi } from 'vitest';
import {
  buildPublicReference,
  idOrPublicReferenceWhere,
  withPublicReference,
} from '../../src/lib/public-reference.js';

describe('buildPublicReference', () => {
  it('produces "<PREFIX>-" followed by 6 characters', () => {
    const ref = buildPublicReference('PROP');
    expect(ref).toMatch(/^PROP-[A-Z0-9]{6}$/);
  });

  it('uses only the visually-unambiguous alphabet (no 0/O or 1/I)', () => {
    for (let i = 0; i < 200; i++) {
      const ref = buildPublicReference('MR');
      const token = ref.slice('MR-'.length);
      expect(token).not.toMatch(/[01OI]/);
    }
  });

  it('respects whatever prefix is given', () => {
    expect(buildPublicReference('WO').startsWith('WO-')).toBe(true);
    expect(buildPublicReference('COM').startsWith('COM-')).toBe(true);
    expect(buildPublicReference('RFQ').startsWith('RFQ-')).toBe(true);
  });

  it('is not derived from any input — two calls never collide in practice', () => {
    const refs = new Set(Array.from({ length: 500 }, () => buildPublicReference('LOT')));
    expect(refs.size).toBe(500);
  });
});

describe('withPublicReference', () => {
  it('calls persist once with a generated reference and returns its result on success', async () => {
    const persist = vi.fn(async (ref: string) => ({ id: 'row_1', publicReference: ref }));
    const result = await withPublicReference('PROP', persist);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.publicReference).toMatch(/^PROP-[A-Z0-9]{6}$/);
  });

  it('retries with a fresh reference on a unique-constraint collision (P2002), never re-querying first', async () => {
    let attempt = 0;
    const seenRefs: string[] = [];
    const persist = vi.fn(async (ref: string) => {
      attempt++;
      seenRefs.push(ref);
      if (attempt < 3) {
        const err = new Error('Unique constraint failed') as Error & {
          code: string;
          meta: { target: string };
        };
        err.code = 'P2002';
        err.meta = { target: 'publicReference' };
        throw err;
      }
      return { id: 'row_1', publicReference: ref };
    });

    const result = await withPublicReference('WO', persist, 5);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(result.publicReference).toBe(seenRefs[2]);
    // Every attempt used a different candidate — never retried with the
    // exact same (already-rejected) reference.
    expect(new Set(seenRefs).size).toBe(3);
  });

  it('propagates a non-collision error immediately, without retrying', async () => {
    const persist = vi.fn(async () => {
      throw new Error('database is on fire');
    });
    await expect(withPublicReference('COM', persist, 5)).rejects.toThrow('database is on fire');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts consecutive collisions, never retrying forever', async () => {
    const persist = vi.fn(async () => {
      const err = new Error('Unique constraint failed') as Error & {
        code: string;
        meta: { target: string };
      };
      err.code = 'P2002';
      err.meta = { target: 'publicReference' };
      throw err;
    });
    await expect(withPublicReference('MR', persist, 3)).rejects.toThrow();
    expect(persist).toHaveBeenCalledTimes(3);
  });

  it('never retries a P2002 on a DIFFERENT unique constraint (e.g. a lot number collision) — regenerating the publicReference can never fix that, and retrying the same persist call again inside an open transaction would only mask the real error', async () => {
    const persist = vi.fn(async () => {
      const err = new Error('Unique constraint failed') as Error & {
        code: string;
        meta: { target: string };
      };
      err.code = 'P2002';
      err.meta = { target: 'spaces_propertyId_lotNumber_key' };
      throw err;
    });
    await expect(withPublicReference('LOT', persist, 5)).rejects.toMatchObject({
      code: 'P2002',
      meta: { target: 'spaces_propertyId_lotNumber_key' },
    });
    expect(persist).toHaveBeenCalledTimes(1); // never retried
  });
});

describe('idOrPublicReferenceWhere', () => {
  it('builds an OR clause matching either the id or the publicReference field', () => {
    expect(idOrPublicReferenceWhere('cmtq224jz0076up9xpleomo46')).toEqual({
      OR: [{ id: 'cmtq224jz0076up9xpleomo46' }, { publicReference: 'cmtq224jz0076up9xpleomo46' }],
    });
    expect(idOrPublicReferenceWhere('PROP-K7M4Q2')).toEqual({
      OR: [{ id: 'PROP-K7M4Q2' }, { publicReference: 'PROP-K7M4Q2' }],
    });
  });
});
