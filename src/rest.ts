// GitHub REST v3: repositories, contents, labels, issues, comments, pulls, branches, commits, refs.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearer, sendError, sendJson, sendRaw, MalformedJson, parseJsonBody } from './http.ts';
import { buildTree, parseTree, type TreeEntry } from './git/objects.ts';
import { store, nowIso, type Issue, type Pull, type Repo } from './store.ts';

type Json = Record<string, unknown>;

const API_ROOT = '/api/v3';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function b64encode(data: Buffer): string {
  return data.toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

// ------------------------------------------------------------------ resource shapes

function userObject(login: string): Json {
  return {
    login,
    id: 1000,
    node_id: `MDQ6VXNlcjEwMDA=`,
    avatar_url: `https://avatars.example.invalid/u/${login}`,
    type: 'User',
    site_admin: false,
    url: `${API_ROOT}/users/${login}`,
    html_url: `https://example.invalid/${login}`,
  };
}

function repoObject(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(repo.owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    has_issues: true,
    has_projects: true,
    has_wiki: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    open_issues: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    language: null,
    visibility: repo.private ? 'private' : 'public',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `${API_ROOT}/repos/${repo.owner}/${repo.name}`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
  };
}

function labelObject(repo: Repo, name: string): Json {
  const label = repo.labels.get(name);
  return {
    id: name.split('').reduce((sum, chr) => sum + chr.charCodeAt(0), 0),
    node_id: Buffer.from(`Label${name}`).toString('base64'),
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
    default: false,
    url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/labels/${name}`,
  };
}

function issueObject(repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue${issue.id}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelObject(repo, name)),
    user: userObject(issue.author),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    locked: false,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${API_ROOT}/repos/${repo.owner}/${repo.name}`,
  };
}

function pullObject(repo: Repo, pull: Pull): Json {
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest${pull.id}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? true : null,
    mergeable_state: pull.state === 'open' ? 'clean' : 'unknown',
    draft: false,
    head: {
      ref: pull.head.ref,
      sha: pull.head.sha,
      label: `${repo.owner}:${pull.head.ref}`,
      user: userObject(repo.owner),
      repo: repoObject(repo),
    },
    base: {
      ref: pull.base.ref,
      sha: pull.base.sha,
      label: `${repo.owner}:${pull.base.ref}`,
      user: userObject(repo.owner),
      repo: repoObject(repo),
    },
    user: userObject(pull.author),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitObject(repo: Repo, oid: string): Json {
  const view = store.commitView(repo, oid);
  // git stores the message with a trailing newline; the REST API reports it without one.
  const message = (view?.message ?? '').replace(/\n+$/, '');
  const author = view?.author ?? '';
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(author);
  const name = match?.[1] ?? repo.owner;
  const email = match?.[2] ?? `${repo.owner}@example.invalid`;
  const date = match === null ? repo.createdAt : new Date(Number(match[3]) * 1000).toISOString();
  return {
    sha: oid,
    node_id: Buffer.from(`Commit${oid}`).toString('base64'),
    commit: {
      message,
      author: { name, email, date },
      committer: { name, email, date },
      tree: { sha: view?.tree ?? '', url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/git/trees/${view?.tree ?? ''}` },
      comment_count: 0,
    },
    url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${oid}`,
    parents: (view?.parents ?? []).map((parent) => ({ sha: parent, url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
  };
}

// ------------------------------------------------------------------ helpers

function repoPathOf(repo: Repo): string {
  return `/repos/${repo.owner}/${repo.name}`;
}

function findRepo(owner: string, name: string): Repo | undefined {
  return store.getRepo(owner, name);
}

function pageParams(url: URL): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function linkHeader(req: Request, count: number, perPage: number, page: number, url: URL): Record<string, string> {
  const base = baseUrlOf(req as unknown as IncomingMessage);
  const build = (target: number): string => {
    const copy = new URL(url.toString());
    copy.searchParams.set('per_page', String(perPage));
    copy.searchParams.set('page', String(target));
    return `<${base}${copy.pathname}${copy.search}>`;
  };
  const links: string[] = [];
  if (page * perPage < count) links.push(`${build(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${build(page - 1)}; rel="prev"`);
  links.push(`${build(1)}; rel="first"`);
  if (count > 0) links.push(`${build(Math.max(1, Math.ceil(count / perPage)))}; rel="last"`);
  return { link: links.join(', ') };
}

function slice<T>(items: T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** The tree id of a branch (or commitish), defaulting to the default branch. */
function branchTree(repo: Repo, ref: string | undefined): string | undefined {
  return store.treeOf(repo, ref === undefined || ref === '' ? repo.defaultBranch : ref);
}

/** Apply a path → blob (or null for delete) map onto a root tree. */
function applyPaths(repo: Repo, rootTree: string, changes: Map<string, string | null>): string {
  let current = rootTree;
  for (const [path, blob] of changes) {
    const next = store.writeTreePath(repo, current, path.split('/').filter((part) => part !== ''), blob);
    if (next !== null) current = next;
  }
  return current;
}

// ------------------------------------------------------------------ route handlers

function listRepoIssues(repo: Repo, url: URL): Issue[] {
  const state = url.searchParams.get('state') ?? 'open';
  const sort = url.searchParams.get('sort') ?? 'created';
  const direction = url.searchParams.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => {
    let delta = 0;
    if (sort === 'updated') delta = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else if (sort === 'comments') delta = a.comments.length - b.comments.length;
    else delta = a.number - b.number;
    if (delta === 0) delta = a.number - b.number;
    return direction === 'asc' ? delta : -delta;
  });
  return issues;
}

function listPulls(repo: Repo, url: URL): Pull[] {
  const state = url.searchParams.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => a.number - b.number);
  return pulls;
}

function listContents(repo: Repo, ref: string | undefined, path: string): { status: number; body: unknown } {
  const tree = branchTree(repo, ref);
  if (tree === undefined) return { status: 404, body: { message: 'Not Found' } };
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
  const found = store.lookupPath(repo, tree, clean);
  if (found === undefined) return { status: 404, body: { message: 'Not Found' } };
  if (found.type === 'blob') {
    const object = repo.objects.get(found.oid);
    const data = object?.data ?? Buffer.alloc(0);
    const name = clean.split('/').pop() ?? clean;
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name,
        path: clean,
        content: `${b64encode(data)}\n`,
        sha: found.oid,
        url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/contents/${clean}`,
        git_url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/git/blobs/${found.oid}`,
        html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${ref ?? repo.defaultBranch}/${clean}`,
        download_url: `https://example.invalid/${repo.owner}/${repo.name}/raw/${ref ?? repo.defaultBranch}/${clean}`,
        _links: {},
      },
    };
  }
  const object = repo.objects.get(found.oid);
  const entries = object === undefined ? [] : parseTree(object.data);
  const listing = entries.map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    name: entry.name,
    path: clean === '' ? entry.name : `${clean}/${entry.name}`,
    sha: entry.oid,
    url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/contents/${clean === '' ? entry.name : `${clean}/${entry.name}`}`,
    git_url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${ref ?? repo.defaultBranch}/${clean === '' ? entry.name : `${clean}/${entry.name}`}`,
    download_url: null,
  }));
  return { status: 200, body: listing };
}

export function mergePull(repo: Repo, pull: Pull, method: string): { status: number; body: unknown } {
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
  if (baseTip !== undefined) pull.base.sha = baseTip;
  if (headTip !== undefined) pull.head.sha = headTip;
  if (pull.state === 'closed' && pull.merged) return { status: 200, body: { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' } };
  if (baseTip === undefined || headTip === undefined) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  const mergeBase = store.mergeBase(repo, baseTip, headTip);
  if (mergeBase === null) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  const baseChanged = store.changedPaths(repo, mergeBase, baseTip);
  const headChanged = store.changedPaths(repo, mergeBase, headTip);
  for (const path of headChanged) {
    if (baseChanged.has(path)) return { status: 405, body: { message: 'Pull Request is not mergeable: merge conflict' } };
  }
  const baseTree = store.commitView(repo, baseTip)?.tree ?? '';
  const headFlatten = store.flatten(repo, store.commitView(repo, headTip)?.tree);
  const baseFlatten = store.flatten(repo, store.commitView(repo, mergeBase)?.tree);
  const changes = new Map<string, string | null>();
  for (const path of headChanged) {
    const after = headFlatten.get(path);
    const before = baseFlatten.get(path);
    if (before === undefined && after !== undefined) changes.set(path, after.oid);
    else if (before !== undefined && after === undefined) changes.set(path, null);
    else if (before !== undefined && after !== undefined && before.oid !== after.oid) changes.set(path, after.oid);
  }
  const tree = applyPaths(repo, baseTree, changes);
  const message = method === 'merge'
    ? `Merge pull request #${pull.number} from ${pull.head.ref}`
    : `${pull.title} (#${pull.number})`;
  const commit = store.createCommit(repo, {
    tree,
    parents: [baseTip],
    message,
  });
  repo.refs.set(`refs/heads/${pull.base.ref}`, commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.updatedAt = pull.mergedAt;
  pull.mergeCommitSha = commit;
  pull.base.sha = commit;
  return { status: 200, body: { sha: commit, merged: true, message: 'Pull Request successfully merged' } };
}

/** Dispatch one /api/v3 request. Answers true when it handled the request. */
export async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): Promise<boolean> {
  const rawPath = url.pathname;
  if (rawPath !== API_ROOT && !rawPath.startsWith(`${API_ROOT}/`)) return false;
  const tail = rawPath.slice(API_ROOT.length).replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = tail === '' ? [] : tail.split('/').map((segment) => decodeURIComponent(segment));
  const method = (req.method ?? 'GET').toUpperCase();

  if (bearer(req) === null) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }

  if (segments.length === 0) {
    sendJson(res, 200, {
      current_user_url: `${API_ROOT}/user`,
      current_user_authorizations_html_url: 'https://github.com/settings/connections/applications{/client_id}',
      authorizations_url: `${API_ROOT}/authorizations`,
      code_search_url: `${API_ROOT}/search/code?q={query}{&page,per_page,sort,order}`,
      emojis_url: `${API_ROOT}/emojis`,
      events_url: `${API_ROOT}/events`,
      feeds_url: `${API_ROOT}/feeds`,
      followers_url: `${API_ROOT}/user/followers`,
      following_url: `${API_ROOT}/user/following{/target}`,
      gists_url: `${API_ROOT}/gists{/gist_id}`,
      hub_url: `${API_ROOT}/hub`,
      issue_search_url: `${API_ROOT}/search/issues?q={query}{&page,per_page,sort,order}`,
      notifications_url: `${API_ROOT}/notifications`,
      organization_repositories_url: `${API_ROOT}/orgs/{org}/repos{?type,page,per_page,sort}`,
      organization_url: `${API_ROOT}/orgs/{org}`,
      public_gists_url: `${API_ROOT}/gists/public`,
      rate_limit_url: `${API_ROOT}/rate_limit`,
      repository_url: `${API_ROOT}/repos/{owner}/{repo}`,
      repository_search_url: `${API_ROOT}/search/repositories?q={query}{&page,per_page,sort,order}`,
      user_url: `${API_ROOT}/users/{user}`,
      user_repositories_url: `${API_ROOT}/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${API_ROOT}/search/users?q={query}{&page,per_page,sort,order}`,
    }, { 'x-oauth-scopes': 'repo, read:org, gist' });
    return true;
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    sendJson(res, 200, {
      verifiable_password_authentication: true,
      installed_version: '3.0.0-makefun-forge',
      ssh_key_fingerprints: {},
    });
    return true;
  }

  if (segments[0] === 'rate_limit') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600, used: 1 } });
    return true;
  }

  if (segments[0] === 'user' && segments.length === 1) {
    sendJson(res, 200, userObject(store.login));
    return true;
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = store.listRepos(store.login);
      const { perPage, page } = pageParams(url);
      sendJson(res, 200, slice(repos, perPage, page).map(repoObject), linkHeader(req as unknown as Request, repos.length, perPage, page, url));
      return true;
    }
    if (method === 'POST') {
      let payload: unknown;
      try {
        payload = parseJsonBody(body);
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const input = (payload ?? {}) as Json;
      const name = str(input.name).trim();
      if (name === '') {
        sendError(res, 422, 'Repository creation failed.', { errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] });
        return true;
      }
      const existing = store.getRepo(store.login, name);
      if (existing !== undefined) {
        sendError(res, 422, 'Repository creation failed. name already exists on this account', {
          errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }],
        });
        return true;
      }
      const repo = store.createRepo(store.login, name, {
        description: str(input.description),
        private: input.private === true,
        defaultBranch: str(input.default_branch) === '' ? 'main' : str(input.default_branch),
      });
      sendJson(res, 201, repoObject(repo));
      return true;
    }
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }

  if (segments[0] !== 'repos' || segments.length < 3) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  const owner = segments[1];
  const name = segments[2];
  const repo = findRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const rest = segments.slice(3);
  const tailPath = rest.join('/');

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoObject(repo));
      return true;
    }
    if (method === 'PATCH') {
      let payload: unknown;
      try {
        payload = parseJsonBody(body);
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const input = (payload ?? {}) as Json;
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      if (typeof input.name === 'string' && input.name !== '' && input.name !== repo.name) {
        store.deleteRepo(repo.owner, repo.name);
        repo.name = input.name;
        store.repos.set(store.key(repo.owner, repo.name), repo);
      }
      sendJson(res, 200, repoObject(repo));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      res.writeHead(204, { 'x-github-request-id': `rest-${Date.now().toString(16)}` });
      res.end();
      return true;
    }
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }

  // contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const result = listContents(repo, url.searchParams.get('ref') ?? undefined, path);
      sendJson(res, result.status, result.body);
      return true;
    }
    let payload: Json;
    try {
      payload = (parseJsonBody(body) ?? {}) as Json;
    } catch (err) {
      if (err instanceof MalformedJson) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      throw err;
    }
    if (method === 'PUT') {
      if (path === '') {
        sendError(res, 422, 'Invalid request: path is required');
        return true;
      }
      const branch = typeof payload.branch === 'string' && payload.branch !== '' ? payload.branch : repo.defaultBranch;
      const tree = branchTree(repo, branch);
      const existing = tree === undefined ? undefined : store.lookupPath(repo, tree, path);
      const sha = typeof payload.sha === 'string' ? payload.sha : undefined;
      if (sha !== undefined && existing !== undefined && existing.oid !== sha) {
        sendError(res, 409, `${path} does not match ${sha}`);
        return true;
      }
      if (sha !== undefined && existing === undefined) {
        sendError(res, 422, `sha ${sha} does not exist for ${path}`);
        return true;
      }
      if (typeof payload.content !== 'string') {
        sendError(res, 422, 'content is required');
        return true;
      }
      const content = b64decode(payload.content);
      if (repo.refs.get(`refs/heads/${branch}`) === undefined && tree === undefined) {
        repo.refs.set(`refs/heads/${branch}`, '');
      }
      const result = store.commitFile(repo, {
        branch,
        path,
        content,
        message: str(payload.message) === '' ? `Update ${path}` : str(payload.message),
        author: store.login,
      });
      const body2 = {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: result.blob ?? '',
          size: content.length,
          encoding: 'base64',
          content: `${payload.content}\n`,
          type: 'file',
        },
        commit: {
          sha: result.commit,
          message: str(payload.message),
          html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${result.commit}`,
        },
      };
      sendJson(res, existing === undefined ? 201 : 200, body2);
      return true;
    }
    if (method === 'DELETE') {
      const tree = branchTree(repo, typeof payload.branch === 'string' ? payload.branch : undefined);
      const existing = tree === undefined ? undefined : store.lookupPath(repo, tree, path);
      if (existing === undefined || existing.type !== 'blob') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const result = store.commitFile(repo, {
        branch: typeof payload.branch === 'string' && payload.branch !== '' ? payload.branch : repo.defaultBranch,
        path,
        content: null,
        message: str(payload.message) === '' ? `Delete ${path}` : str(payload.message),
        author: store.login,
      });
      sendJson(res, 200, { content: null, commit: { sha: result.commit, message: str(payload.message) } });
      return true;
    }
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }

  // labels
  if (rest[0] === 'labels') {
    if (method === 'POST') {
      let payload: Json;
      try {
        payload = (parseJsonBody(body) ?? {}) as Json;
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const labelName = str(payload.name);
      if (labelName === '') {
        sendError(res, 422, 'name is required');
        return true;
      }
      repo.labels.set(labelName, { name: labelName, color: str(payload.color) || 'ededed', description: str(payload.description) });
      sendJson(res, 201, labelObject(repo, labelName));
      return true;
    }
    if (method === 'GET') {
      const names = [...repo.labels.keys()];
      const { perPage, page } = pageParams(url);
      sendJson(res, 200, slice(names, perPage, page).map((labelName) => labelObject(repo, labelName)));
      return true;
    }
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }

  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const issues = listRepoIssues(repo, url);
        const { perPage, page } = pageParams(url);
        sendJson(res, 200, slice(issues, perPage, page).map((issue) => issueObject(repo, issue)), linkHeader(req as unknown as Request, issues.length, perPage, page, url));
        return true;
      }
      if (method === 'POST') {
        let payload: Json;
        try {
          payload = (parseJsonBody(body) ?? {}) as Json;
        } catch {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const title = str(payload.title);
        if (title === '') {
          sendError(res, 422, 'Validation Failed', { errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] });
          return true;
        }
        const labels = Array.isArray(payload.labels) ? payload.labels.filter((entry): entry is string => typeof entry === 'string') : [];
        const unknown = labels.filter((labelName) => !repo.labels.has(labelName));
        if (unknown.length > 0) {
          sendError(res, 422, `Validation Failed: ${unknown.join(', ')} is not a label on this repository`, {
            errors: unknown.map((labelName) => ({ resource: 'Issue', field: 'labels', code: 'invalid', message: `${labelName} is not a label` })),
          });
          return true;
        }
        const issue = store.createIssue(repo, { title, body: str(payload.body), labels });
        sendJson(res, 201, issueObject(repo, issue));
        return true;
      }
      sendError(res, 405, 'Method Not Allowed');
      return true;
    }
    const number = Number.parseInt(rest[1], 10);
    const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
    if (issue === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (rest.length === 2) {
      if (method === 'GET') {
        sendJson(res, 200, issueObject(repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        let payload: Json;
        try {
          payload = (parseJsonBody(body) ?? {}) as Json;
        } catch {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        if (payload.state === 'closed' || payload.state === 'open') issue.state = payload.state;
        if (typeof payload.title === 'string') issue.title = payload.title;
        if (typeof payload.body === 'string') issue.body = payload.body;
        if (Array.isArray(payload.labels)) {
          const labels = payload.labels.filter((entry): entry is string => typeof entry === 'string');
          const unknown = labels.filter((labelName) => !repo.labels.has(labelName));
          if (unknown.length > 0) {
            sendError(res, 422, `Validation Failed: ${unknown.join(', ')} is not a label on this repository`);
            return true;
          }
          issue.labels = labels;
        }
        issue.updatedAt = nowIso();
        sendJson(res, 200, issueObject(repo, issue));
        return true;
      }
      sendError(res, 405, 'Method Not Allowed');
      return true;
    }
    if (rest[2] === 'comments') {
      if (method === 'GET') {
        const { perPage, page } = pageParams(url);
        sendJson(res, 200, slice(issue.comments, perPage, page).map((comment) => ({
          id: comment.id,
          node_id: Buffer.from(`IssueComment${comment.id}`).toString('base64'),
          body: comment.body,
          user: userObject(comment.author),
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
          html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
          url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
        })));
        return true;
      }
      if (method === 'POST') {
        let payload: Json;
        try {
          payload = (parseJsonBody(body) ?? {}) as Json;
        } catch {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const commentBody = str(payload.body);
        if (commentBody === '') {
          sendError(res, 422, 'Validation Failed');
          return true;
        }
        const comment = store.createComment(repo, issue, commentBody);
        sendJson(res, 201, {
          id: comment.id,
          node_id: Buffer.from(`IssueComment${comment.id}`).toString('base64'),
          body: comment.body,
          user: userObject(comment.author),
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
          url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
        });
        return true;
      }
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const pulls = listPulls(repo, url);
        const { perPage, page } = pageParams(url);
        sendJson(res, 200, slice(pulls, perPage, page).map((pull) => pullObject(repo, pull)));
        return true;
      }
      if (method === 'POST') {
        let payload: Json;
        try {
          payload = (parseJsonBody(body) ?? {}) as Json;
        } catch {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const head = str(payload.head);
        const base = str(payload.base) || repo.defaultBranch;
        if (head === '') {
          sendError(res, 422, 'Validation Failed: head is required');
          return true;
        }
        const headSha = repo.refs.get(`refs/heads/${head}`);
        if (headSha === undefined) {
          sendError(res, 422, `Validation Failed: head sha can't be blank, no commits between ${base} and ${head}`, {
            errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
          });
          return true;
        }
        const pull = store.createPull(repo, { title: str(payload.title) || `${head} into ${base}`, body: str(payload.body), head, base });
        pull.head.sha = headSha;
        sendJson(res, 201, pullObject(repo, pull));
        return true;
      }
      sendError(res, 405, 'Method Not Allowed');
      return true;
    }
    const number = Number.parseInt(rest[1], 10);
    const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
    if (pull === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      sendJson(res, 200, pullObject(repo, pull));
      return true;
    }
    if (rest.length === 2 && method === 'PATCH') {
      let payload: Json = {};
      try {
        payload = (parseJsonBody(body) ?? {}) as Json;
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (payload.state === 'closed' || payload.state === 'open') pull.state = payload.state;
      if (typeof payload.title === 'string') pull.title = payload.title;
      if (typeof payload.body === 'string') pull.body = payload.body;
      pull.updatedAt = nowIso();
      sendJson(res, 200, pullObject(repo, pull));
      return true;
    }
    if (rest[2] === 'files' && method === 'GET') {
      const mergeBase = pull.head.sha === '' || pull.base.sha === ''
        ? undefined
        : store.mergeBase(repo, pull.base.sha, pull.head.sha) ?? undefined;
      const baseCommit = mergeBase ?? (repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha);
      const headCommit = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
      const files = store.diffCommits(repo, baseCommit, headCommit);
      sendJson(res, 200, files.map((file) => ({
        sha: repo.refs.get(`refs/heads/${pull.head.ref}`) ?? '',
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        blob_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${pull.head.sha}/${file.filename}`,
        raw_url: `https://example.invalid/${repo.owner}/${repo.name}/raw/${pull.head.sha}/${file.filename}`,
        contents_url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/contents/${file.filename}?ref=${pull.head.sha}`,
      })));
      return true;
    }
    if (rest[2] === 'merge' && method === 'PUT') {
      let payload: Json = {};
      try {
        payload = (parseJsonBody(body) ?? {}) as Json;
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const result = mergePull(repo, pull, str(payload.merge_method) || 'squash');
      sendJson(res, result.status, result.body);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // branches / refs / commits
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([ref, oid]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha: oid, url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/commits/${oid}` },
          protected: false,
        }));
      sendJson(res, 200, branches);
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const ref = `refs/heads/${rest[1]}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) {
        sendError(res, 404, 'Branch not found');
        return true;
      }
      sendJson(res, 200, { name: rest[1], commit: { sha: oid }, protected: false });
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      let payload: Json;
      try {
        payload = (parseJsonBody(body) ?? {}) as Json;
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const ref = str(payload.ref);
      const sha = str(payload.sha);
      if (ref === '' || !ref.startsWith('refs/')) {
        sendError(res, 422, 'Validation Failed: ref is required');
        return true;
      }
      if (sha === '' || repo.objects.get(sha) === undefined) {
        sendError(res, 422, 'Validation Failed: sha is invalid');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: Buffer.from(`Ref${ref}`).toString('base64'), url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/git/${ref}`, object: { sha, type: 'commit', url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/git/commits/${sha}` } });
      return true;
    }
    if (rest.length >= 3 && method === 'GET') {
      let ref = rest.slice(2).join('/');
      if (!ref.startsWith('refs/')) ref = `refs/${ref}`;
      const oid = repo.refs.get(ref) ?? repo.refs.get(`refs/${rest.slice(2).join('/')}`);
      const target = oid ?? repo.refs.get(`refs/${rest.slice(2).join('/')}`) ?? repo.refs.get(`refs/heads/${rest.slice(2).join('/')}`);
      if (target === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { ref, node_id: Buffer.from(`Ref${ref}`).toString('base64'), url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/git/${ref}`, object: { sha: target, type: 'commit', url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/git/commits/${target}` } });
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const refs = [...repo.refs.entries()].map(([ref, oid]) => ({ ref, object: { sha: oid, type: 'commit' } }));
      sendJson(res, 200, refs);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (rest[0] === 'git' && rest[1] === 'commits' && rest.length === 3 && method === 'GET') {
    const oid = rest[2];
    if (repo.objects.get(oid) === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { ...commitObject(repo, oid), tree: { sha: store.commitView(repo, oid)?.tree ?? '' }, files: [] });
    return true;
  }

  if (rest[0] === 'git' && rest[1] === 'trees' && rest.length >= 3 && method === 'GET') {
    const oid = rest[2];
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const entries: TreeEntry[] = parseTree(object.data);
    sendJson(res, 200, {
      sha: oid,
      url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/git/trees/${oid}`,
      tree: entries.map((entry) => ({
        path: entry.name,
        mode: entry.mode,
        type: entry.mode === '40000' ? 'tree' : 'blob',
        sha: entry.oid,
        size: entry.mode === '40000' ? undefined : (repo.objects.get(entry.oid)?.data.length ?? 0),
        url: `${API_ROOT}/repos/${repo.owner}/${repo.name}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.oid}`,
      })),
      truncated: false,
    });
    return true;
  }

  if (rest[0] === 'commits' && method === 'GET') {
    const sha = url.searchParams.get('sha') ?? undefined;
    const tip = store.resolveCommitish(repo, sha ?? '');
    if (tip === undefined) {
      sendJson(res, 200, []);
      return true;
    }
    const all = store.commitLog(repo, tip);
    const { perPage, page } = pageParams(url);
    sendJson(res, 200, slice(all, perPage, page).map((oid) => commitObject(repo, oid)), linkHeader(req as unknown as Request, all.length, perPage, page, url));
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}

export { sendRaw, b64encode, b64decode };
