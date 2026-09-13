import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  QUERY_MAIN,
  QUERY_REPOS,
  aggregate,
  renderMarkdown,
  renderSvg,
  replaceBlock,
  main,
} from './stats.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/response.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-09-14T04:00:12.345Z');
const SENTINEL = /SECRET-/;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof next === 'function' ? next() : next;
  };
  fn.calls = calls;
  return fn;
}

const okFetch = () => fakeFetch(() => json(fixture.main), () => json(fixture.page2));

function sink() {
  let out = '';
  return { write: (s) => { out += s; }, get text() { return out; } };
}

async function workspace(readme = '# Hi\n\n<!-- STATS:START -->\nold\n<!-- STATS:END -->\n') {
  const dir = await mkdtemp(join(tmpdir(), 'stats-test-'));
  await writeFile(join(dir, 'README.md'), readme);
  return dir;
}

async function run(dir, { argv = [], env = { GH_STATS_TOKEN: 't' }, fetch = okFetch(), now = NOW } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await main({ argv, env, fetch, cwd: dir, now, stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

async function collect() {
  const main = fixture.main.data.viewer;
  const repoNodes = [...main.repositories.nodes, ...fixture.page2.data.viewer.repositories.nodes];
  return aggregate(main, repoNodes);
}

// --- privacy ---------------------------------------------------------------

test('privacy: queries never select repository identity fields', () => {
  for (const q of [QUERY_MAIN, QUERY_REPOS]) {
    assert.doesNotMatch(q, /\b(nameWithOwner|description|url|homepageUrl|resourcePath|owner|openGraphImageUrl)\b/);
    // The only `name` allowed is a language name.
    const names = q.match(/\bname\b/g) ?? [];
    const languageNames = q.match(/node\s*\{\s*name\s+color\s*\}/g) ?? [];
    assert.equal(names.length, languageNames.length, 'unexpected `name` field in query');
    // Every `repository { ... }` selection holds only privacy/fork flags and language sizes.
    for (const sel of repositorySelections(q)) {
      const rest = sel
        .replace(/languages\([^)]*\)\s*\{\s*edges\s*\{\s*size\s+node\s*\{\s*name\s+color\s*\}\s*\}\s*\}/, '')
        .split(/\s+/)
        .filter(Boolean);
      assert.ok(rest.every((f) => f === 'isPrivate' || f === 'isFork'), `unexpected repository fields: ${rest}`);
    }
  }
  assert.equal(repositorySelections(QUERY_MAIN).length, 4);
});

function repositorySelections(query) {
  const out = [];
  for (const m of query.matchAll(/\brepository\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (depth > 0) {
      if (query[i] === '{') depth++;
      else if (query[i] === '}') depth--;
      i++;
    }
    out.push(query.slice(start, i - 1));
  }
  return out;
}

test('privacy: rendered markdown and svg contain no private repository names or descriptions', async () => {
  const stats = await collect();
  const md = renderMarkdown(stats, { now: NOW });
  const svg = renderSvg(stats.languages);
  assert.doesNotMatch(JSON.stringify(stats), SENTINEL);
  assert.doesNotMatch(md, SENTINEL);
  assert.doesNotMatch(svg, SENTINEL);
});

test('privacy: dry-run output and written files contain no sentinels', async () => {
  const dir = await workspace();
  try {
    const dry = await run(dir, { argv: ['--dry-run'] });
    assert.equal(dry.code, 0, dry.stderr);
    assert.doesNotMatch(dry.stdout + dry.stderr, SENTINEL);

    const real = await run(dir);
    assert.equal(real.code, 0, real.stderr);
    assert.doesNotMatch(real.stdout + real.stderr, SENTINEL);
    assert.doesNotMatch(await readFile(join(dir, 'README.md'), 'utf8'), SENTINEL);
    assert.doesNotMatch(await readFile(join(dir, 'assets', 'langs.svg'), 'utf8'), SENTINEL);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- aggregation -----------------------------------------------------------

test('aggregate computes totals, active days and private share', async () => {
  const s = await collect();
  assert.equal(s.totalContributions, 1367);
  assert.equal(s.commits, 1188);
  assert.equal(s.pullRequests, 41);
  assert.equal(s.reviews, 12);
  assert.equal(s.issues, 7);
  assert.equal(s.contributionsThisYear, 1011);
  assert.equal(s.reposContributedTo, 9);
  assert.equal(s.stars, 8);
  assert.deepEqual(s.activeDays, { active: 5, total: 10 });
  assert.equal(Math.round(s.privateShare * 100), 93);
});

test('languages: only repos committed to in the last 12 months, forks excluded, ignore list, top 5 plus Other', async () => {
  const { languages } = await collect();
  assert.deepEqual(
    languages.map((l) => [l.name, l.percent.toFixed(1)]),
    [['Java', '55.4'], ['TypeScript', '27.7'], ['Kotlin', '7.4'], ['Python', '5.5'], ['C#', '2.8'], ['Other', '1.3']],
  );
  assert.ok(!languages.some((l) => ['HTML', 'Shell', 'C++'].includes(l.name)));
});

test('svg escapes language names and rejects non-hex colors', () => {
  const svg = renderSvg([
    { name: '<script>', percent: 60, color: 'javascript:alert(1)' },
    { name: 'A&B', percent: 40, color: '#abc' },
  ]);
  assert.doesNotMatch(svg, /<script>|javascript:/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /A&amp;B/);
});

// --- rendering -------------------------------------------------------------

test('markdown shows code reviews, hides rows below threshold and includes footer', async () => {
  const md = renderMarkdown(await collect(), { now: NOW });
  assert.match(md, /\*\*1,367\*\* contributions in the last 12 months/);
  assert.match(md, /\| Pull requests \| 41 \|/);
  assert.match(md, /\| Code reviews \| 12 \|/);
  assert.doesNotMatch(renderMarkdown({ ...(await collect()), pullRequests: 3 }, { now: NOW }), /Pull requests/);
  assert.doesNotMatch(md, /Stars|Issues/);
  assert.match(md, /!\[.*\]\(assets\/langs\.svg\)/);
  assert.match(md, /Last updated: 2026-09-14T04:00:12Z · includes private contributions/);
  assert.match(md, /<!-- stats:total=1367 -->/);
});

test('replaceBlock replaces between markers', () => {
  const out = replaceBlock('a\n<!-- STATS:START -->\nold\n<!-- STATS:END -->\nb\n', 'new');
  assert.equal(out, 'a\n<!-- STATS:START -->\nnew\n<!-- STATS:END -->\nb\n');
});

test('replaceBlock appends markers when missing', () => {
  const out = replaceBlock('# Hi\n', 'new');
  assert.equal(out, '# Hi\n\n<!-- STATS:START -->\nnew\n<!-- STATS:END -->\n');
});

// --- behaviour of main -----------------------------------------------------

test('dry-run prints everything and touches no files', async () => {
  const dir = await workspace();
  try {
    const before = await readFile(join(dir, 'README.md'), 'utf8');
    const r = await run(dir, { argv: ['--dry-run'] });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Stars earned/);
    assert.match(r.stdout, /STATS:START/);
    assert.match(r.stdout, /<svg/);
    assert.equal(await readFile(join(dir, 'README.md'), 'utf8'), before);
    await assert.rejects(readFile(join(dir, 'assets', 'langs.svg')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('paginates repositories with the cursor', async () => {
  const dir = await workspace();
  try {
    const fetch = okFetch();
    await run(dir, { argv: ['--dry-run'], fetch });
    assert.equal(fetch.calls.length, 2);
    assert.equal(fetch.calls[1].variables.cursor, 'CURSOR1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unchanged numbers keep the old timestamp (no diff)', async () => {
  const dir = await workspace();
  try {
    assert.equal((await run(dir)).code, 0);
    const first = await readFile(join(dir, 'README.md'), 'utf8');
    assert.equal((await run(dir, { now: new Date('2026-09-15T04:00:00Z') })).code, 0);
    assert.equal(await readFile(join(dir, 'README.md'), 'utf8'), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const failures = [
  ['missing token', { env: {} }, /GH_STATS_TOKEN/],
  ['401', { fetch: fakeFetch(() => json({ message: 'Bad credentials' }, 401)) }, /401/],
  [
    'rate limit via headers',
    { fetch: fakeFetch(() => json({ message: 'rate limited' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1789362000' })) },
    /rate limit/i,
  ],
  ['graphql errors', { fetch: fakeFetch(() => json({ data: null, errors: [{ message: 'Field boom' }] })) }, /Field boom/],
  ['empty response', { fetch: fakeFetch(() => json({ data: { viewer: null } })) }, /empty/i],
  ['non-json body', { fetch: fakeFetch(() => new Response('<html>', { status: 200 })) }, /JSON/],
  [
    'wrong account',
    { fetch: fakeFetch(() => json({ data: { ...fixture.main.data, viewer: { ...fixture.main.data.viewer, login: 'someone' } } })) },
    /someone/,
  ],
  ['failure on second page', { fetch: fakeFetch(() => json(fixture.main), () => json({ message: 'x' }, 502)) }, /502/],
];

for (const [name, opts, message] of failures) {
  test(`fails without writing: ${name}`, async () => {
    const dir = await workspace();
    try {
      const before = await readFile(join(dir, 'README.md'), 'utf8');
      const r = await run(dir, opts);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, message);
      assert.equal(await readFile(join(dir, 'README.md'), 'utf8'), before);
      await assert.rejects(readFile(join(dir, 'assets', 'langs.svg')));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('refuses a suspicious drop unless --force', async () => {
  const dir = await workspace('<!-- STATS:START -->\n<!-- stats:total=5000 -->\n<!-- STATS:END -->\n');
  try {
    const before = await readFile(join(dir, 'README.md'), 'utf8');
    const r = await run(dir);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /5,000|5000/);
    assert.equal(await readFile(join(dir, 'README.md'), 'utf8'), before);

    const forced = await run(dir, { argv: ['--force'] });
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(await readFile(join(dir, 'README.md'), 'utf8'), /stats:total=1367/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
