#!/usr/bin/env node
// Builds the static site into dist/.
//
// Feed entries come from two places:
//   posts/*.md   — things I write
//   GitHub API   — my public repos, enriched with live links from data/sites.json
//
// The GitHub call is best-effort: on failure we fall back to data/repos.cache.json
// so a rate limit or an outage can never break a deploy.

import { readFile, writeFile, mkdir, rm, readdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const dist = path.join(root, 'dist')
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'))

const config = await readJson(path.join(root, 'site.config.json'))
const sites = await readJson(path.join(root, 'data', 'sites.json'))

// Netlify sets URL to the production address; use it so RSS links are correct.
const siteUrl = (process.env.URL || config.url).replace(/\/$/, '')

/* ---------------------------------------------------------------- helpers */

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString(config.language || 'en-gb', {
    day: 'numeric', month: 'long', year: 'numeric',
  })

// Minimal YAML-ish frontmatter: key: value, plus [a, b] lists.
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { data: {}, body: raw }
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i === -1) continue
    const key = line.slice(0, i).trim()
    let val = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      data[key] = val
    }
  }
  return { data, body: raw.slice(m[0].length) }
}

function excerpt(markdown, limit = 220) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > limit ? text.slice(0, text.lastIndexOf(' ', limit)) + '…' : text
}

/* ------------------------------------------------------------ data: repos */

async function loadRepos() {
  const cachePath = path.join(root, 'data', 'repos.cache.json')
  const headers = {
    'User-Agent': `${config.githubUser}-blog-build`,
    Accept: 'application/vnd.github+json',
  }
  // Optional: set GITHUB_TOKEN in Netlify env vars to raise the rate limit.
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

  try {
    const res = await fetch(
      `https://api.github.com/users/${config.githubUser}/repos?per_page=100&sort=pushed`,
      { headers },
    )
    if (!res.ok) throw new Error(`GitHub API responded ${res.status}`)
    const repos = (await res.json()).map((r) => ({
      name: r.name,
      description: r.description,
      html_url: r.html_url,
      homepage: r.homepage,
      language: r.language,
      stargazers_count: r.stargazers_count,
      pushed_at: r.pushed_at,
      fork: r.fork,
      archived: r.archived,
      private: r.private,
    }))
    await writeFile(cachePath, JSON.stringify(repos, null, 2) + '\n')
    console.log(`  github: fetched ${repos.length} repos (cache refreshed)`)
    return repos
  } catch (err) {
    console.warn(`  github: ${err.message} — falling back to cache`)
    if (!existsSync(cachePath)) {
      console.warn('  github: no cache present, feed will contain posts only')
      return []
    }
    return readJson(cachePath)
  }
}

/* ------------------------------------------------------------ data: posts */

async function loadPosts() {
  const dir = path.join(root, 'posts')
  if (!existsSync(dir)) return []
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md'))

  const posts = []
  for (const file of files) {
    const raw = await readFile(path.join(dir, file), 'utf8')
    const { data, body } = parseFrontmatter(raw)
    if (String(data.draft) === 'true') continue
    const slug = data.slug || slugify(file.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, ''))
    posts.push({
      kind: 'post',
      title: data.title || slug,
      date: data.date || new Date().toISOString(),
      summary: data.summary || excerpt(body),
      tags: data.tags || [],
      slug,
      url: `/p/${slug}/`,
      html: marked.parse(body),
    })
  }
  return posts
}

/* ------------------------------------------------------- data: repo entries */

function buildProjectEntries(repos) {
  const excluded = new Set(config.excludeRepos || [])

  const fromApi = repos
    .filter((r) => !r.private && !r.fork && !excluded.has(r.name))
    .map((r) => {
      const meta = sites[r.name] || {}
      const live = meta.live || (r.homepage ? normaliseUrl(r.homepage) : null)
      return {
        kind: 'project',
        name: r.name,
        title: meta.title || r.name,
        date: meta.date || r.pushed_at,
        summary: meta.blurb || r.description || 'No description yet.',
        repo: r.html_url,
        live,
        language: meta.language || r.language,
        stars: r.stargazers_count,
        archived: r.archived,
        url: live || r.html_url,
      }
    })

  // Entries marked alwaysShow render from data/sites.json alone — for repos the
  // public API can't see yet (still private) or that live outside GitHub. Once
  // the repo goes public the API takes over and supplies the live metadata.
  const seen = new Set(fromApi.map((e) => e.name))
  const manual = Object.entries(sites)
    .filter(([name, meta]) => name[0] !== '_' && meta.alwaysShow && !seen.has(name) && !excluded.has(name))
    .map(([name, meta]) => ({
      kind: 'project',
      name,
      title: meta.title || name,
      date: meta.date || new Date().toISOString(),
      summary: meta.blurb || 'No description yet.',
      repo: meta.repo || `https://github.com/${config.githubUser}/${name}`,
      live: meta.live || null,
      language: meta.language || null,
      stars: 0,
      archived: false,
      url: meta.live || meta.repo || `https://github.com/${config.githubUser}/${name}`,
    }))

  if (manual.length) console.log(`  sites: ${manual.length} manual entr(ies) not returned by the API`)
  return [...fromApi, ...manual]
}

const normaliseUrl = (u) => (/^https?:\/\//.test(u) ? u : `https://${u}`)

/* ------------------------------------------------------------- templating */

function layout({ title, description, body, canonical, activeNav }) {
  const isHome = activeNav === 'home'
  return `<!doctype html>
<html lang="${esc(config.language || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="${isHome ? 'website' : 'article'}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary">
<link rel="alternate" type="application/rss+xml" title="${esc(config.title)}" href="/feed.xml">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="masthead">
  <div class="wrap">
    <a class="brand" href="/">${esc(config.title)}</a>
    <nav>
      <a href="/"${isHome ? ' aria-current="page"' : ''}>Feed</a>
      <a href="https://github.com/${esc(config.githubUser)}" rel="me">GitHub</a>
      <a href="/feed.xml">RSS</a>
    </nav>
  </div>
</header>

<main class="wrap">
${body}
</main>

<footer class="wrap">
  <p>© ${new Date().getFullYear()} ${esc(config.author)} · <a href="https://github.com/${esc(config.githubUser)}">@${esc(config.githubUser)}</a> · <a href="/feed.xml">RSS</a></p>
</footer>
</body>
</html>
`
}

function projectCard(e) {
  const tags = [e.language, e.archived ? 'archived' : null, e.stars > 0 ? `★ ${e.stars}` : null]
    .filter(Boolean)
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join('')
  const live = e.live
    ? `<a class="link-live" href="${esc(e.live)}">Live site ↗</a>`
    : ''
  return `<article class="entry entry-project">
  <p class="meta"><span class="kind">Project</span><time datetime="${esc(e.date)}">${esc(fmtDate(e.date))}</time></p>
  <h2><a href="${esc(e.url)}">${esc(e.title)}</a></h2>
  <p class="summary">${esc(e.summary)}</p>
  <p class="links">${live}<a class="link-repo" href="${esc(e.repo)}">Source ↗</a></p>
  ${tags ? `<p class="tags">${tags}</p>` : ''}
</article>`
}

function postCard(e) {
  return `<article class="entry entry-post">
  <p class="meta"><span class="kind">Post</span><time datetime="${esc(e.date)}">${esc(fmtDate(e.date))}</time></p>
  <h2><a href="${esc(e.url)}">${esc(e.title)}</a></h2>
  <p class="summary">${esc(e.summary)}</p>
  <p class="links"><a class="link-repo" href="${esc(e.url)}">Read →</a></p>
</article>`
}

function renderIndex(entries) {
  const body = `<section class="intro">
  <h1>${esc(config.title)}</h1>
  <p class="tagline">${esc(config.tagline)}</p>
</section>

<section class="feed">
${entries.map((e) => (e.kind === 'post' ? postCard(e) : projectCard(e))).join('\n')}
</section>`

  return layout({
    title: config.title,
    description: config.tagline,
    canonical: `${siteUrl}/`,
    activeNav: 'home',
    body,
  })
}

function renderPost(post) {
  const body = `<article class="post">
  <p class="meta"><time datetime="${esc(post.date)}">${esc(fmtDate(post.date))}</time></p>
  <h1>${esc(post.title)}</h1>
  ${post.html}
  <p class="back"><a href="/">← Back to the feed</a></p>
</article>`

  return layout({
    title: `${post.title} · ${config.title}`,
    description: post.summary,
    canonical: `${siteUrl}${post.url}`,
    activeNav: 'post',
    body,
  })
}

function render404() {
  return layout({
    title: `Not found · ${config.title}`,
    description: 'That page does not exist.',
    canonical: `${siteUrl}/404`,
    activeNav: '404',
    body: `<section class="intro"><h1>Not found</h1><p class="tagline">That page doesn't exist. <a href="/">Back to the feed</a>.</p></section>`,
  })
}

function renderRss(entries) {
  const items = entries.slice(0, 50).map((e) => {
    const link = e.kind === 'post' ? `${siteUrl}${e.url}` : e.url
    return `    <item>
      <title>${esc(e.title)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="false">${esc(link)}</guid>
      <pubDate>${new Date(e.date).toUTCString()}</pubDate>
      <description>${esc(e.summary)}</description>
    </item>`
  }).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(config.title)}</title>
    <link>${esc(siteUrl)}/</link>
    <description>${esc(config.tagline)}</description>
    <language>${esc(config.language || 'en')}</language>
    <atom:link href="${esc(siteUrl)}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`
}

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#1a1a1a"/><text x="32" y="45" font-family="Georgia,serif" font-size="38" fill="#fff" text-anchor="middle">J</text></svg>
`

/* ------------------------------------------------------------------ build */

console.log('building…')

const [repos, posts] = await Promise.all([loadRepos(), loadPosts()])
const projects = buildProjectEntries(repos)
const entries = [...posts, ...projects].sort((a, b) => new Date(b.date) - new Date(a.date))

console.log(`  feed: ${posts.length} post(s) + ${projects.length} project(s)`)
if (!entries.length) {
  console.error('  no entries — refusing to publish an empty feed')
  process.exit(1)
}

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

await writeFile(path.join(dist, 'index.html'), renderIndex(entries))
await writeFile(path.join(dist, '404.html'), render404())
await writeFile(path.join(dist, 'feed.xml'), renderRss(entries))
await writeFile(path.join(dist, 'favicon.svg'), favicon)
await copyFile(path.join(root, 'src', 'styles.css'), path.join(dist, 'styles.css'))

for (const post of posts) {
  const dir = path.join(dist, 'p', post.slug)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'index.html'), renderPost(post))
}

console.log(`done → dist/ (${entries.length} entries, ${posts.length} post page(s))`)
