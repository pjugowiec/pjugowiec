#!/usr/bin/env node
// Refreshes the stats block in README.md and assets/langs.svg from the GitHub GraphQL API.
//
//   GH_STATS_TOKEN=... node scripts/stats.mjs            write files
//   GH_STATS_TOKEN=... node scripts/stats.mjs --dry-run  print everything, write nothing
//   GH_STATS_TOKEN=... node scripts/stats.mjs --force    accept a >50% drop in total contributions
//
// Privacy: the queries never select repository names, descriptions or URLs, so nothing
// identifying a private repository can reach the output. See stats.test.mjs.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LOGIN = 'pjugowiec';
const API_URL = 'https://api.github.com/graphql';
const MAX_PAGES = 50;
const DROP_RATIO = 0.5;

export const DISPLAY = {
  rows: ['activeDays', 'privateShare', 'commits', 'pullRequests', 'reviews'],
  threshold: { pullRequests: 25 },
  languages: { top: 5, ignore: ['HTML', 'CSS', 'SCSS', 'Dockerfile', 'Shell', 'Makefile'] },
};

const START = '<!-- STATS:START -->';
const END = '<!-- STATS:END -->';
const README = 'README.md';
const SVG = 'assets/langs.svg';
const OTHER_COLOR = '#8b949e';
const TEXT_COLOR = '#767676'; // ~4.5:1 on white, ~4.2:1 on GitHub dark; one colour, no theme detection needed

// --- queries ---------------------------------------------------------------

const REPOS_FRAGMENT = `
fragment Repos on User {
  repositories(first: 100, after: $cursor, ownerAffiliations: [OWNER], isFork: false) {
    pageInfo { hasNextPage endCursor }
    nodes { stargazerCount }
  }
}`;

const byRepository = (field, extra = '') => `
      ${field}(maxRepositories: 100) {
        repository { isPrivate${extra} }
        contributions { totalCount }
      }`;

// Languages come from repositories committed to in the last 12 months (any owner),
// so the bar reflects current work rather than old personal projects.
const LANGUAGES = `
          isFork
          languages(first: 100, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name color } }
          }
        `;

export const QUERY_MAIN = `
query Stats($ytdFrom: DateTime!, $ytdTo: DateTime!, $cursor: String) {
  rateLimit { cost remaining resetAt }
  viewer {
    login
    lastYear: contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalIssueContributions
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks { contributionDays { contributionCount } }
      }${byRepository('commitContributionsByRepository', LANGUAGES)}${byRepository('pullRequestContributionsByRepository')}${byRepository('pullRequestReviewContributionsByRepository')}${byRepository('issueContributionsByRepository')}
    }
    thisYear: contributionsCollection(from: $ytdFrom, to: $ytdTo) {
      contributionCalendar { totalContributions }
    }
    repositoriesContributedTo(
      first: 1
      includeUserRepositories: false
      contributionTypes: [COMMIT, PULL_REQUEST, ISSUE, PULL_REQUEST_REVIEW]
    ) { totalCount }
    ...Repos
  }
}
${REPOS_FRAGMENT}`;

export const QUERY_REPOS = `
query Repos($cursor: String) {
  rateLimit { cost remaining resetAt }
  viewer { ...Repos }
}
${REPOS_FRAGMENT}`;

// --- API -------------------------------------------------------------------

export class StatsError extends Error {}

async function graphql(fetchImpl, token, query, variables) {
  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': `${LOGIN}-stats`,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new StatsError(`Network error while calling GitHub: ${err.message}`);
  }

  if (res.status === 401) {
    throw new StatsError('GitHub rejected the token (401). GH_STATS_TOKEN is invalid, expired or revoked.');
  }
  const remaining = res.headers.get('x-ratelimit-remaining');
  if ((res.status === 403 || res.status === 429) && (remaining === '0' || res.headers.has('retry-after'))) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const when = reset ? new Date(reset * 1000).toISOString() : `in ${res.headers.get('retry-after')}s`;
    throw new StatsError(`GitHub API rate limit exceeded (HTTP ${res.status}); resets ${when}.`);
  }
  if (res.status === 403) {
    throw new StatsError('GitHub refused the request (403). The token probably lacks the required access.');
  }
  if (!res.ok) {
    throw new StatsError(`GitHub API returned HTTP ${res.status}.`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new StatsError('GitHub API returned a response that is not valid JSON.');
  }
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    if (body.errors.some((e) => e.type === 'RATE_LIMITED')) {
      throw new StatsError('GitHub GraphQL rate limit exceeded; try again after the hourly reset.');
    }
    throw new StatsError(`GitHub GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  if (!body?.data?.viewer) {
    throw new StatsError('GitHub API returned an empty response (no viewer data).');
  }
  return body.data;
}

export async function fetchAll({ fetch: fetchImpl, token, now }) {
  const ytdFrom = `${now.getUTCFullYear()}-01-01T00:00:00Z`;
  const first = await graphql(fetchImpl, token, QUERY_MAIN, { ytdFrom, ytdTo: now.toISOString(), cursor: null });
  const viewer = first.viewer;
  if (viewer.login !== LOGIN) {
    throw new StatsError(`Token belongs to "${viewer.login}", expected "${LOGIN}".`);
  }
  if (!viewer.lastYear?.contributionCalendar || !viewer.repositories) {
    throw new StatsError('GitHub API returned an empty response (contribution data missing).');
  }

  const repoNodes = [...viewer.repositories.nodes];
  let page = viewer.repositories.pageInfo;
  let rateLimit = first.rateLimit;
  for (let i = 1; page.hasNextPage; i++) {
    if (i >= MAX_PAGES) throw new StatsError(`Repository pagination exceeded ${MAX_PAGES} pages.`);
    const next = await graphql(fetchImpl, token, QUERY_REPOS, { cursor: page.endCursor });
    if (!next.viewer.repositories) throw new StatsError('GitHub API returned an empty repositories page.');
    repoNodes.push(...next.viewer.repositories.nodes);
    page = next.viewer.repositories.pageInfo;
    rateLimit = next.rateLimit;
  }
  return { viewer, repoNodes, rateLimit };
}

// --- aggregation -----------------------------------------------------------

const BY_REPOSITORY = [
  'commitContributionsByRepository',
  'pullRequestContributionsByRepository',
  'pullRequestReviewContributionsByRepository',
  'issueContributionsByRepository',
];

export function aggregate(viewer, repoNodes, display = DISPLAY) {
  const c = viewer.lastYear;

  const days = c.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
  const activeDays = { active: days.filter((d) => d.contributionCount > 0).length, total: days.length };

  let privateCount = 0;
  let allCount = 0;
  const truncated = [];
  for (const field of BY_REPOSITORY) {
    const list = c[field] ?? [];
    if (list.length >= 100) truncated.push(field);
    for (const entry of list) {
      allCount += entry.contributions.totalCount;
      if (entry.repository?.isPrivate) privateCount += entry.contributions.totalCount;
    }
  }

  return {
    totalContributions: c.contributionCalendar.totalContributions,
    contributionsThisYear: viewer.thisYear.contributionCalendar.totalContributions,
    commits: c.totalCommitContributions,
    pullRequests: c.totalPullRequestContributions,
    reviews: c.totalPullRequestReviewContributions,
    issues: c.totalIssueContributions,
    restricted: c.restrictedContributionsCount,
    reposContributedTo: viewer.repositoriesContributedTo.totalCount,
    stars: repoNodes.reduce((sum, r) => sum + r.stargazerCount, 0),
    activeDays,
    privateShare: allCount > 0 ? privateCount / allCount : 0,
    languages: aggregateLanguages(
      (c.commitContributionsByRepository ?? []).map((e) => e.repository).filter((r) => r && !r.isFork),
      display.languages,
    ),
    truncated,
  };
}

function aggregateLanguages(repos, { top, ignore }) {
  const sizes = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages?.edges ?? []) {
      if (ignore.includes(node.name)) continue;
      const prev = sizes.get(node.name) ?? { size: 0, color: node.color };
      sizes.set(node.name, { size: prev.size + size, color: prev.color ?? node.color });
    }
  }
  const total = [...sizes.values()].reduce((sum, l) => sum + l.size, 0);
  if (total === 0) return [];

  const sorted = [...sizes.entries()]
    .map(([name, { size, color }]) => ({ name, color, percent: (size / total) * 100 }))
    .sort((a, b) => b.percent - a.percent);
  const shown = sorted.slice(0, top);
  const rest = sorted.slice(top).reduce((sum, l) => sum + l.percent, 0);
  if (rest > 0) shown.push({ name: 'Other', color: OTHER_COLOR, percent: rest });
  return shown;
}

// --- rendering -------------------------------------------------------------

const fmt = (n) => n.toLocaleString('en-US');

const ROWS = {
  activeDays: { label: 'Active days', value: (s) => `${fmt(s.activeDays.active)} / ${fmt(s.activeDays.total)}` },
  privateShare: { label: 'In private repositories', value: (s) => `${Math.round(s.privateShare * 100)}%` },
  commits: { label: 'Commits', value: (s) => fmt(s.commits) },
  pullRequests: { label: 'Pull requests', value: (s) => fmt(s.pullRequests) },
  reviews: { label: 'Code reviews', value: (s) => fmt(s.reviews) },
  issues: { label: 'Issues', value: (s) => fmt(s.issues) },
  reposContributedTo: { label: 'Repos contributed to', value: (s) => fmt(s.reposContributedTo) },
  stars: { label: 'Stars earned', value: (s) => fmt(s.stars) },
};

export function renderMarkdown(stats, { display = DISPLAY } = {}) {
  const rows = display.rows
    .filter((key) => !(key in display.threshold) || stats[key] >= display.threshold[key])
    .map((key) => `| ${ROWS[key].label} | ${ROWS[key].value(stats)} |`);
  const alt = stats.languages.length
    ? `Top languages: ${stats.languages.map((l) => `${l.name} ${l.percent.toFixed(1)}%`).join(', ')}`
    : 'Top languages: no data';

  return [
    `<!-- stats:total=${stats.totalContributions} -->`,
    `**${fmt(stats.totalContributions)}** contributions in the last 12 months`,
    '',
    '| Metric | Value |',
    '| :--- | ---: |',
    ...rows,
    '',
    `![${alt.replace(/[[\]]/g, '')}](assets/langs.svg)`,
  ].join('\n');
}

const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
const safeColor = (c) => (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(c ?? '') ? c : OTHER_COLOR);

export function renderSvg(languages) {
  const width = 400;
  const rowHeight = 22;
  const rows = Math.max(1, Math.ceil(languages.length / 2));
  const height = 34 + (rows - 1) * rowHeight + 8;

  let x = 0;
  const segments = languages.map((l, i) => {
    const w = i === languages.length - 1 ? width - x : (l.percent / 100) * width;
    const rect = `<rect x="${x.toFixed(2)}" y="0" width="${Math.max(0, w).toFixed(2)}" height="10" fill="${safeColor(l.color)}"/>`;
    x += w;
    return rect;
  });
  if (segments.length === 0) segments.push(`<rect x="0" y="0" width="${width}" height="10" fill="${OTHER_COLOR}"/>`);

  const legend = languages.length
    ? languages.map((l, i) => {
        const cx = (i % 2) * (width / 2);
        const cy = 34 + Math.floor(i / 2) * rowHeight;
        return (
          `<circle cx="${cx + 5}" cy="${cy - 4}" r="5" fill="${safeColor(l.color)}"/>` +
          `<text x="${cx + 16}" y="${cy}">${escapeXml(l.name)} ${l.percent.toFixed(1)}%</text>`
        );
      })
    : ['<text x="0" y="34">No language data</text>'];

  const title = languages.map((l) => `${l.name} ${l.percent.toFixed(1)}%`).join(', ') || 'No language data';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
    `<title>${escapeXml(`Top languages: ${title}`)}</title>`,
    `<style>text{font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:${TEXT_COLOR}}</style>`,
    `<clipPath id="bar"><rect width="${width}" height="10" rx="5"/></clipPath>`,
    `<g clip-path="url(#bar)">${segments.join('')}</g>`,
    ...legend,
    '</svg>',
    '',
  ].join('\n');
}

// --- README ----------------------------------------------------------------

function currentBlock(readme) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END, start);
  if (start === -1 || end === -1) return null;
  return readme.slice(start + START.length, end).replace(/^\n|\n$/g, '');
}

export function replaceBlock(readme, block) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END, start);
  if (start === -1 || end === -1) {
    const sep = readme.length === 0 || readme.endsWith('\n\n') ? '' : readme.endsWith('\n') ? '\n' : '\n\n';
    return `${readme}${sep}${START}\n${block}\n${END}\n`;
  }
  return `${readme.slice(0, start + START.length)}\n${block}\n${readme.slice(end)}`;
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// --- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { dryRun: false, force: false };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--force') opts.force = true;
    else throw new StatsError(`Unknown argument: ${arg}`);
  }
  return opts;
}

function summary(stats, rateLimit) {
  const lines = [
    ['Contributions (last 12 months)', fmt(stats.totalContributions)],
    ['Contributions this calendar year', fmt(stats.contributionsThisYear)],
    ['Commits', fmt(stats.commits)],
    ['Pull requests', fmt(stats.pullRequests)],
    ['Code reviews', fmt(stats.reviews)],
    ['Issues', fmt(stats.issues)],
    ['Restricted contributions', fmt(stats.restricted)],
    ['Active days', ROWS.activeDays.value(stats)],
    ['In private repositories', ROWS.privateShare.value(stats)],
    ['Repos contributed to', fmt(stats.reposContributedTo)],
    ['Stars earned', fmt(stats.stars)],
    ['Languages', stats.languages.map((l) => `${l.name} ${l.percent.toFixed(1)}%`).join(', ') || '-'],
    ['Rate limit remaining', rateLimit ? fmt(rateLimit.remaining) : '-'],
  ];
  return lines.map(([k, v]) => `  ${k.padEnd(34)}${v}`).join('\n');
}

export async function main({ argv, env, fetch: fetchImpl, cwd, now, stdout, stderr }) {
  try {
    const opts = parseArgs(argv);
    const token = env.GH_STATS_TOKEN?.trim();
    if (!token) {
      throw new StatsError('GH_STATS_TOKEN is not set. See the maintainer notes at the bottom of README.md.');
    }

    const readmePath = join(cwd, README);
    const svgPath = join(cwd, SVG);
    const readme = (await readOptional(readmePath)) ?? '';

    const { viewer, repoNodes, rateLimit } = await fetchAll({ fetch: fetchImpl, token, now });
    const stats = aggregate(viewer, repoNodes);
    for (const field of stats.truncated) {
      stderr.write(`warning: ${field} hit the 100-repository limit; private share may be approximate\n`);
    }

    const old = currentBlock(readme);
    const prevTotal = Number(old?.match(/<!-- stats:total=(\d+) -->/)?.[1]);
    if (prevTotal && stats.totalContributions < prevTotal * DROP_RATIO && !opts.force) {
      throw new StatsError(
        `Total contributions dropped from ${fmt(prevTotal)} to ${fmt(stats.totalContributions)} (more than 50%). ` +
          'The token probably cannot see private contributions. Re-run with --force if this is expected.',
      );
    }

    const block = renderMarkdown(stats);
    const svg = renderSvg(stats.languages);

    if (opts.dryRun) {
      stdout.write(`Metrics (including hidden rows):\n${summary(stats, rateLimit)}\n\n`);
      stdout.write(`${START}\n${block}\n${END}\n\n--- ${SVG} ---\n${svg}`);
      return 0;
    }

    const newReadme = replaceBlock(readme, block);
    const writes = [];
    if (newReadme !== readme) writes.push([readmePath, newReadme]);
    if ((await readOptional(svgPath)) !== svg) writes.push([svgPath, svg]);

    // Stage everything first, then swap in, so a failure never leaves half-updated files.
    await mkdir(join(cwd, 'assets'), { recursive: true });
    for (const [path, content] of writes) await writeFile(`${path}.tmp`, content);
    for (const [path] of writes) await rename(`${path}.tmp`, path);

    stdout.write(writes.length ? `Updated: ${writes.map(([p]) => p.slice(cwd.length + 1)).join(', ')}\n` : 'No changes.\n');
    return 0;
  } catch (err) {
    stderr.write(`stats: ${err instanceof StatsError ? err.message : err.stack}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main({
    argv: process.argv.slice(2),
    env: process.env,
    fetch: globalThis.fetch,
    cwd: process.cwd(),
    now: new Date(),
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
