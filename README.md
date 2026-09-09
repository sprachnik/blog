# blog

A small static feed — posts I write, plus every public repo under
[@sprachnik](https://github.com/sprachnik) with links to its source and live
deployment. No framework, one dependency, builds in under a second.

Built with [Pico CSS](https://picocss.com) and about 300 lines of Node.

## Running it

```bash
npm install
npm run build     # → dist/
npm run dev       # build, then serve dist/ locally
```

## Adding things

| I want to… | Edit |
| --- | --- |
| Write a post | new `.md` file in `posts/` |
| Link a repo to its live site | `data/sites.json` |
| Hide a repo from the feed | `excludeRepos` in `site.config.json` |
| Change the title, tagline or social links | `site.config.json` |
| Stop pulling in Medium | set `mediumFeed` to `null` |
| Change the look | `src/styles.css` |

Post frontmatter supports `title`, `date`, `summary`, `tags`, `slug`, and
`draft: true`. See `posts/2026-09-09-how-this-works.md`.

## What's in the feed

Three kinds of entry, sorted newest-first:

- **Projects** — public repos from the GitHub API, dated by repo creation, with
  live URLs from `data/sites.json`
- **Writing** — posts from the Medium RSS feed, linked out to, never copied
- **Posts** — markdown in `posts/`, hosted here at `/p/<slug>/`

## How the feed stays current

`scripts/build.mjs` calls the GitHub API at build time for the repo list,
descriptions, languages, stars and push dates, then merges in the live URLs from
`data/sites.json`. Results are written to `data/repos.cache.json`; if the API
call fails the build falls back to that cache, so a rate limit can't break a
deploy.

The API is called unauthenticated (60 requests/hour per IP). Netlify build
runners share IPs, so if you start seeing the cache fallback in build logs, add a
`GITHUB_TOKEN` environment variable in the Netlify UI — a fine-grained token with
no scopes at all is enough for public repo data, and raises the limit to 5,000/hour.

### Picking up new repos automatically

Deploys are triggered by pushes to `main`. To also refresh on a schedule so new
repos appear without a commit, create a build hook in
**Site configuration → Build & deploy → Build hooks**, then POST to it from any
cron (GitHub Actions, cron-job.org, etc.):

```
curl -X POST -d '{}' https://api.netlify.com/build_hooks/YOUR_HOOK_ID
```

## Deployment

Pushes to `main` deploy automatically via Netlify.
