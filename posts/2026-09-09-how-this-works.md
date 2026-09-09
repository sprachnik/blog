---
title: How this site works
date: 2026-09-09
summary: A short note on what's in the feed, and how to add to it. Delete this post once you've written a real one.
tags: [meta]
draft: true
---

The feed below mixes two kinds of thing.

**Projects** are pulled straight from the GitHub API at build time — every public,
non-forked repo under [@sprachnik](https://github.com/sprachnik). Each one links to
its source, and to a live deployment where there is one. Push a new repo and it
appears here on the next deploy; no editing required.

**Posts** are markdown files in `posts/`. This is one.

## Writing a post

Drop a `.md` file into `posts/`. The frontmatter block at the top sets the title,
date, and the summary shown in the feed:

```markdown
---
title: Something I learned
date: 2026-09-15
summary: One or two sentences for the feed.
tags: [notes]
---

Write here. Standard markdown — headings, `code`, [links](https://example.com),
lists, quotes, images.
```

Set `draft: true` to keep a file out of the build while you work on it. The
filename becomes the URL, minus any date prefix — so this file is served at
`/p/how-this-works/`.

## Adding a live link to a project

Projects find their deployment through `data/sites.json`, which maps a repo name
to a URL:

```json
"my-new-thing": {
  "title": "My New Thing",
  "live": "https://mynewthing.netlify.app"
}
```

A repo with no entry there still shows up — it just gets a source link and
nothing else. If a repo shouldn't appear at all, add its name to `excludeRepos`
in `site.config.json`.
