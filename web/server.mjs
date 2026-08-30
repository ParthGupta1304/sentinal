#!/usr/bin/env node
/**
 * Dashboard server.
 *
 * Deliberately a ~90-line static server rather than the Next.js app in PRD §9.1. The one
 * screen that carries the demo is the run view, and it needs exactly three things from a
 * server: the run index, a verdict document, and the raw outputs for a case when a human
 * expands it. A build step would add risk without adding capability.
 *
 * Raw model outputs are read from disk on demand and never loaded up front — the same
 * separation §7 asks for, where the verdict holds file refs and the bodies stay on disk.
 *
 *   node web/server.mjs        → http://localhost:4310
 */

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const runsDir = join(root, 'runs');
const PORT = Number(process.env.PORT ?? 4310);

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/** Comparison runs only — calibration runs write no verdict.json. */
async function listRuns() {
  let entries;
  try {
    entries = await readdir(runsDir);
  } catch {
    return [];
  }
  const runs = [];
  for (const name of entries) {
    try {
      const raw = await readFile(join(runsDir, name, 'verdict.json'), 'utf8');
      const v = JSON.parse(raw);
      runs.push({
        run_id: v.run_id,
        verdict: v.verdict,
        counts: v.counts,
        finished_at: v.finished_at,
        head_path: v.head_path,
      });
    } catch {
      // No verdict.json: a calibration run, or a comparison still in flight.
    }
  }
  return runs.sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (path === '/' || path === '/index.html') {
      return send(res, 200, await readFile(join(here, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }

    if (path === '/api/runs') {
      return send(res, 200, { runs: await listRuns() });
    }

    if (path.startsWith('/api/runs/')) {
      const runId = decodeURIComponent(path.slice('/api/runs/'.length));
      if (runId.includes('/') || runId.includes('..')) return send(res, 400, { error: 'bad run id' });
      try {
        return send(res, 200, JSON.parse(await readFile(join(runsDir, runId, 'verdict.json'), 'utf8')));
      } catch {
        return send(res, 404, { error: `no run ${runId}` });
      }
    }

    // Raw outputs, fetched only when a human expands a case.
    if (path === '/api/output') {
      const ref = url.searchParams.get('ref') ?? '';
      // The ref comes from a verdict document, but it still arrives over HTTP, so treat it
      // as untrusted: resolve it and require that it stay inside runs/.
      const resolved = normalize(join(root, ref));
      if (!resolved.startsWith(runsDir + '/')) return send(res, 400, { error: 'ref outside runs/' });
      try {
        await stat(resolved);
        return send(res, 200, await readFile(resolved, 'utf8'));
      } catch {
        return send(res, 404, { error: 'output not found' });
      }
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Sentinel dashboard  ·  http://localhost:${PORT}`);
  console.log(`reading runs from   ${runsDir}`);
});
