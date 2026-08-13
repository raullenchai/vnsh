import * as fs from 'node:fs';
import * as path from 'node:path';

const START = '<!-- vnsh:init:start -->';
const END = '<!-- vnsh:init:end -->';

export const VNSH_PROJECT_INSTRUCTIONS = `${START}
## vnsh workspaces

Use vnsh when work needs to move between an AI agent and a person, or between
agents. Create a workspace with \`npx -y vnsh@latest <file>\` or by piping text
to that command. Return the complete URL exactly as printed; its fragment holds
the decryption key.

When given a \`vnsh.dev/w/\` or \`vnsh.dev/artifact/\` URL, read it with
\`npx -y vnsh@latest read '<complete-url>'\`. Use \`write\` only with an edit
link carrying \`#w=\`, and re-read before retrying a version conflict. Never
send the URL fragment, root secret, or decrypted content to vnsh APIs directly.
${END}`;

export interface InitResult {
  root: string;
  files: Array<{ path: string; action: 'created' | 'updated' | 'unchanged' }>;
}

export function projectIsInitialized(directory = process.cwd()): boolean {
  let current = path.resolve(directory);
  for (;;) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = path.join(current, name);
      try {
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(START)) return true;
      } catch {
        // Attribution must never make an upload fail because an ancestor is unreadable.
      }
    }
    if (fs.existsSync(path.join(current, '.git'))) return false;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function upsertInstructions(file: string): 'created' | 'updated' | 'unchanged' {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${VNSH_PROJECT_INSTRUCTIONS}\n`, { encoding: 'utf8', flag: 'wx' });
    return 'created';
  }
  const current = fs.readFileSync(file, 'utf8');
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if (start >= 0 && end >= start) {
    const next = current.slice(0, start) + VNSH_PROJECT_INSTRUCTIONS + current.slice(end + END.length);
    if (next === current) return 'unchanged';
    fs.writeFileSync(file, next, 'utf8');
    return 'updated';
  }
  const separator = current.length === 0 || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(file, `${current}${separator}${VNSH_PROJECT_INSTRUCTIONS}\n`, 'utf8');
  return 'updated';
}

export function initProject(directory = '.'): InitResult {
  const root = path.resolve(directory);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${directory}`);

  const candidates = ['AGENTS.md', 'CLAUDE.md'].filter((name) =>
    fs.existsSync(path.join(root, name)),
  );
  if (candidates.length === 0) candidates.push('AGENTS.md');

  return {
    root,
    files: candidates.map((name) => {
      const file = path.join(root, name);
      return { path: file, action: upsertInstructions(file) };
    }),
  };
}
