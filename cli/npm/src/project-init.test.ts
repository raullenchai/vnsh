import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject, projectIsInitialized } from './project-init.js';

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'vnsh-init-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project init', () => {
  it('creates portable AGENTS.md instructions in an empty project', () => {
    const root = temp();
    expect(initProject(root).files[0].action).toBe('created');
    const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(text).toContain('npx -y vnsh@latest read');
    expect(text).toContain('complete URL exactly as printed');
    expect(projectIsInitialized(root)).toBe(true);
  });

  it('updates every existing agent instruction file and is idempotent', () => {
    const root = temp();
    writeFileSync(join(root, 'AGENTS.md'), '# Existing\n');
    writeFileSync(join(root, 'CLAUDE.md'), '# Claude\n');
    expect(initProject(root).files.map((file) => file.action)).toEqual(['updated', 'updated']);
    expect(initProject(root).files.map((file) => file.action)).toEqual(['unchanged', 'unchanged']);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8').match(/vnsh:init:start/g)).toHaveLength(1);
  });

  it('refreshes an older managed block without disturbing surrounding text', () => {
    const root = temp();
    writeFileSync(join(root, 'AGENTS.md'), 'before\n<!-- vnsh:init:start -->\nold\n<!-- vnsh:init:end -->\nafter\n');
    expect(initProject(root).files[0].action).toBe('updated');
    const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(text).toMatch(/^before/);
    expect(text).toContain('after\n');
    expect(text).not.toContain('\nold\n');
  });
});
