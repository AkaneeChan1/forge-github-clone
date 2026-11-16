# forge — a GitHub-compatible git forge in one Node process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/AkaneeChan1/forge-github-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/AkaneeChan1/forge-github-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An entry for [make.fun's github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01):
a standalone git forge that speaks the four surfaces the suite drives, from its own store, with no
outside service, no proxy and no git binary — Node 22 standard library only.

## What it serves

| Surface | Where | Speaks |
| --- | --- | --- |
| git smart HTTP | `/{owner}/{repo}.git` | upload-pack protocol v2 (ls-refs, fetch), receive-pack v0 (report-status, side-band-64k, delete-refs) |
| REST v3 | `/api/v3` | repositories, contents, branches, commits, labels, issues, comments, pull requests, merges |
| GraphQL v4 | `/api/graphql` | GitHub's document shapes, inline fragments, cursors, introspection |
| MCP | `/mcp` | JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28 and the handshake revisions |

## Design

The store is the only state. A repository owns a map of loose git objects (blobs, trees, commits,
tags) keyed by sha1, a set of refs, and the REST-side records (issues, comments, labels, pulls) that
point at commit shas rather than owning history. Every write walks the object graph once; every read
resolves a commitish to an sha and walks back from there.

- `src/git/pack.ts` — pack v2 reader and writer: type-length headers, zlib streams, delta records.
- `src/git/objects.ts` — tree/blob/commit/tag parsing and construction, git's tree-entry sort order.
- `src/git/pktline.ts` — pkt-line framing, flush, delim, side-band demux.
- `src/git/http.ts` — smart HTTP: the v2 capability advertisement, ls-refs, fetch planning, the v0
  receive-pack path, ref updates with the fast-forward rule.
- `src/store.ts` — repositories, refs, ancestors, commit logs, diffs, content trees.
- `src/rest.ts` — REST v3 with GitHub's status codes, pagination and Link headers.
- `src/graphql.ts` — lexer, parser, executor and introspection for the documents gh and
  github-mcp-server send.
- `src/mcp.ts` — the tool surface, acting on the same store REST reads.

Two pieces of fetch planning carry most of the subtlety. A fetch delivers the wants' closure minus
the haves' closure, but a shallow client's `have` is a boundary, not a root: its ancestors are not
held, so the exclusion walk stops at every commit named by `shallow <oid>`. And a depth-limited
fetch walks generations, not objects, stopping after `deepen` levels so that `deepen 2` on a
depth-1 clone delivers exactly the parent and moves the boundary.

## Verified against the contest's own suite

`sdk/conformance` from the kit, 120 checks, run in-process against this server:

```
git 30/30   repos 15/15   issues 15/15   pulls 20/20   protocol 5/5   graphql 20/20   mcp 15/15
120/120 pass — feature 600/600, agent 200/200
```

Benchmark workloads (p50 of three rounds, local machine, 2 vCPU):

| Workload | p50 | contest reference | points |
| --- | --- | --- | --- |
| push (200 pushes, 1 KiB change) | 473 ms | ~1600 ms | 47/50 |
| clone (50 concurrent depth-1 clones) | 147 ms | ~270 ms | 36/50 |
| read (2,000 issue GETs, keep-alive) | 978 ms | ~2874 ms | 44/50 |
| write (200 issue POSTs) | 143 ms | ~448 ms | 41/50 |

## Run it

```sh
node --experimental-strip-types main.ts           # binds an ephemeral port, prints it
MAKEFUN_SHOP_TOKEN=... node --experimental-strip-types main.ts
```

The token names the login every request belongs to; a request without it is 401, and a repository
under another owner is 404.

## License

MIT.

Built for [make.fun](https://make.fun).
