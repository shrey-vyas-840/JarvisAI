import { describe, expect, it } from 'vitest';

import { createVerifyArtifactTool } from '../../../src/tools/filesystem/verify-artifact.js';
import { asRecord, createContext, createTempRoots, writeBinary, writeText } from './helpers.js';

describe('verify_artifact tool', () => {
  it('independently verifies exact text, a directory, and PNG dimensions', async () => {
    const roots = createTempRoots();
    try {
      writeText(roots.workspace, 'notes.txt', 'three exact lines\none\ntwo');
      writeBinary(
        roots.exports,
        'logo.png',
        Buffer.from([
          137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 32, 0, 0, 0, 16,
        ]),
      );
      const tool = createVerifyArtifactTool({ guard: roots.guard });
      const textArgs = {
        root: 'workspace',
        relativePath: 'notes.txt',
        kind: 'text',
        expectedText: 'three exact lines\none\ntwo',
      };
      const text = asRecord(await tool.execute(textArgs, createContext()));
      const image = asRecord(
        await tool.execute(
          { root: 'exports', relativePath: 'logo.png', kind: 'image' },
          createContext(),
        ),
      );
      const directory = asRecord(
        await tool.execute(
          { root: 'workspace', relativePath: '', kind: 'directory' },
          createContext(),
        ),
      );

      expect(text).toMatchObject({ kind: 'text', exactMatch: true, verified: true });
      expect(image).toMatchObject({
        kind: 'image',
        format: 'png',
        width: 32,
        height: 16,
        verified: true,
      });
      expect(directory).toMatchObject({ kind: 'directory', verified: true });
      await expect(tool.verify?.(textArgs, text, createContext())).resolves.toBe(true);
    } finally {
      roots.cleanup();
    }
  });

  it('rejects a text artifact whose independently read contents do not match', async () => {
    const roots = createTempRoots();
    try {
      writeText(roots.workspace, 'notes.txt', 'actual');
      const tool = createVerifyArtifactTool({ guard: roots.guard });
      await expect(
        tool.execute(
          { root: 'workspace', relativePath: 'notes.txt', kind: 'text', expectedText: 'expected' },
          createContext(),
        ),
      ).rejects.toThrow('does not match expected contents');
    } finally {
      roots.cleanup();
    }
  });
});
