import { describe, it, expect } from 'vitest';
import { updateProjectSchema } from './projects.schema.js';

describe('updateProjectSchema repoPath', () => {
  it('accepts a POSIX absolute path', () => {
    const result = updateProjectSchema.safeParse({ repoPath: '/Users/amaan/code/waypoint' });
    expect(result.success).toBe(true);
  });

  // waypoint-frontend ships an nsis Windows target, so both drive-letter
  // separators are real inputs here, not hypothetical ones.
  it('accepts a Windows drive-letter path with either separator', () => {
    expect(updateProjectSchema.safeParse({ repoPath: 'C:\\code\\waypoint' }).success).toBe(true);
    expect(updateProjectSchema.safeParse({ repoPath: 'C:/code/waypoint' }).success).toBe(true);
  });

  it('accepts an explicit null (unlink)', () => {
    const result = updateProjectSchema.safeParse({ repoPath: null });
    expect(result.success).toBe(true);
  });

  it('accepts a patch that omits repoPath entirely', () => {
    const result = updateProjectSchema.safeParse({ name: 'Renamed' });
    expect(result.success).toBe(true);
  });

  it('rejects a relative path', () => {
    expect(updateProjectSchema.safeParse({ repoPath: 'code/waypoint' }).success).toBe(false);
    expect(updateProjectSchema.safeParse({ repoPath: './waypoint' }).success).toBe(false);
    expect(updateProjectSchema.safeParse({ repoPath: '../waypoint' }).success).toBe(false);
    expect(updateProjectSchema.safeParse({ repoPath: '~/waypoint' }).success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(updateProjectSchema.safeParse({ repoPath: '' }).success).toBe(false);
  });

  it('rejects a non-string value', () => {
    expect(updateProjectSchema.safeParse({ repoPath: 42 }).success).toBe(false);
  });

  // requireAtLeastOneField still applies: repoPath doesn't exempt a patch
  // from having to carry at least one field.
  it('still rejects an empty patch body', () => {
    expect(updateProjectSchema.safeParse({}).success).toBe(false);
  });
});
