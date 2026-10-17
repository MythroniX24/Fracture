#!/usr/bin/env node
/**
 * FRACTURE dev launcher.
 *
 * Runs three processes with inherited stdio:
 *   1. @fracture/shared  — tsc --watch so both apps see fresh compiled rules
 *   2. @fracture/server  — tsx watch (authoritative game server)
 *   3. @fracture/client  — vite dev server
 *
 * Usage: npm run dev        (Ctrl+C stops everything)
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let shuttingDown = false;

function run(label, workspace, script) {
  const child = spawn(npmCmd, ['run', script, '-w', workspace], {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev] ${label} exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[dev] starting FRACTURE (shared watcher + server + client)');
run('shared', '@fracture/shared', 'dev');
run('server', '@fracture/server', 'dev');
run('client', '@fracture/client', 'dev');
