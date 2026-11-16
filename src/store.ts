// The one in-memory store: repositories, their git objects and refs, issues, labels, pull requests.
// The git layer and the REST/GraphQL/MCP layers all read and write these same objects.
import { appendFileSync } from 'node:fs';
import {
  buildCommit,
  buildTree,
  hashObject,
  isOid,
  parseCommit,
  parseTree,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './git/objects.ts';

export interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface PullStub {
  ref: string;
  sha: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: PullStub;
  base: PullStub;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  nextIssue: number;
  pulls: Map<number, Pull>;
  nextPull: number;
  labels: Map<string, Label>;
  nextComment: number;
}

export const MAIN = 'refs/heads/main';

let repoSeq = 5000;
let issueSeq = 1;
let commentSeq = 1;
let pullSeq = 1;

function nowIso(): string {
  return new Date().toISOString();
}

export class Store {
  readonly repos = new Map<string, Repo>();
  readonly users = new Map<string, { login: string; email: string; name: string }>();
  /** The login the bearer token names. */
  login: string;

  constructor(login: string) {
    this.login = login;
    this.users.set(login, { login, email: `${login}@example.invalid`, name: login });
  }

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean; defaultBranch?: string } = {}): Repo {
    const repo: Repo = {
      id: repoSeq++,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      createdAt: nowIso(),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      nextIssue: 1,
      pulls: new Map(),
      nextPull: 1,
      labels: new Map(),
      nextComment: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const lower = owner.toLowerCase();
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner.toLowerCase() === lower) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[]; author?: string }): Issue {
    const number = repo.nextIssue++;
    const stamp = nowIso();
    const issue: Issue = {
      id: repo.id * 100000 + number,
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: input.labels ?? [],
      author: input.author ?? this.login,
      createdAt: stamp,
      updatedAt: stamp,
      comments: [],
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string, author?: string): Comment {
    const comment: Comment = { id: commentSeq++, body, author: author ?? this.login, createdAt: nowIso() };
    issue.comments.push(comment);
    issue.updatedAt = comment.createdAt;
    return comment;
  }

  createPull(repo: Repo, input: { title: string; body?: string; head: string; base: string; author?: string }): Pull {
    const number = repo.nextPull++;
    const stamp = nowIso();
    const pull: Pull = {
      id: repo.id * 100000 + number,
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: { ref: input.head, sha: this.refSha(repo, `refs/heads/${input.head}`) ?? '' },
      base: { ref: input.base, sha: this.refSha(repo, `refs/heads/${input.base}`) ?? '' },
      author: input.author ?? this.login,
      createdAt: stamp,
      updatedAt: stamp,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  // ------------------------------------------------------------------ git primitives

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  object(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refSha(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a ref name, a bare branch name, or a commit id to a commit id. */
  resolveCommitish(repo: Repo, name: string): string | undefined {
    if (!name) return this.refSha(repo, `refs/heads/${repo.defaultBranch}`);
    const direct = repo.refs.get(name);
    if (direct !== undefined) return direct;
    const head = repo.refs.get(`refs/heads/${name}`);
    if (head !== undefined) return head;
    const tag = repo.refs.get(`refs/tags/${name}`);
    if (tag !== undefined) {
      const object = repo.objects.get(tag);
      if (object?.type === 'tag') {
        const target = object.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
        if (target) return target[1];
      }
      return tag;
    }
    if (isOid(name) && repo.objects.has(name)) return name;
    return undefined;
  }

  commitView(repo: Repo, oid: string) {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return undefined;
    return parseCommit(object.data);
  }

  /** The tree id a commitish points at, or undefined. */
  treeOf(repo: Repo, commitish: string): string | undefined {
    const oid = this.resolveCommitish(repo, commitish);
    if (oid === undefined) return undefined;
    return this.commitView(repo, oid)?.tree;
  }

  /** Walk a path inside a tree; `type` says whether a blob or a tree was found. */
  lookupPath(repo: Repo, treeOid: string, path: string): { type: 'blob' | 'tree'; oid: string } | undefined {
    const segments = path.split('/').filter((part) => part !== '');
    if (segments.length === 0) return { type: 'tree', oid: treeOid };
    let current = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return undefined;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return undefined;
      if (index === segments.length - 1) {
        return { type: entry.mode === '40000' ? 'tree' : 'blob', oid: entry.oid };
      }
      if (entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    return { type: 'tree', oid: current };
  }

  /** Write (or delete, when `content` is null) one file and commit it on `branch`. */
  commitFile(repo: Repo, options: {
    branch: string;
    path: string;
    content: Buffer | null;
    message: string;
    author?: string;
    email?: string;
    timestamp?: number;
  }): { commit: string; blob: string | null } {
    const ref = `refs/heads/${options.branch}`;
    const parent = repo.refs.get(ref);
    const parentView = parent === undefined ? undefined : this.commitView(repo, parent);
    const rootTree = parentView?.tree ?? this.putObject(repo, 'tree', Buffer.alloc(0));
    const segments = options.path.split('/').filter((part) => part !== '');
    let blob: string | null = null;
    if (options.content !== null) blob = this.putObject(repo, 'blob', options.content);
    const tree = this.writeTreePath(repo, rootTree, segments, blob);
    if (tree === null) return { commit: parent ?? '', blob };
    const commit = buildCommit({
      tree,
      parents: parent === undefined ? [] : [parent],
      message: options.message,
      author: options.author ?? repo.owner,
      email: options.email ?? `${repo.owner}@example.invalid`,
      timestamp: options.timestamp ?? Math.floor(Date.now() / 1000),
    });
    const commitOid = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, commitOid);
    return { commit: commitOid, blob };
  }

  /** Write a commit object from a tree; the caller moves whatever refs it wants. */
  createCommit(repo: Repo, input: { tree: string; parents?: string[]; message: string; author?: string; email?: string; timestamp?: number }): string {
    const commit = buildCommit({
      tree: input.tree,
      parents: input.parents ?? [],
      message: input.message,
      author: input.author ?? repo.owner,
      email: input.email ?? `${repo.owner}@example.invalid`,
      timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
    });
    return this.putObject(repo, 'commit', commit);
  }

  /** Rewrite a tree with `blob` (or nothing, when null) at `segments`; null when nothing changed. */
  writeTreePath(repo: Repo, treeOid: string, segments: string[], blob: string | null): string | null {
    const name = segments[0];
    const object = repo.objects.get(treeOid);
    const entries: TreeEntry[] = object === undefined ? [] : parseTree(object.data);
    const index = entries.findIndex((entry) => entry.name === name);
    const existing = index >= 0 ? entries[index] : undefined;
    let replacement: TreeEntry | undefined;
    if (segments.length === 1) {
      if (blob === null) {
        if (existing === undefined) return null;
        entries.splice(index, 1);
      } else {
        replacement = { mode: '100644', name, oid: blob };
        if (existing !== undefined && existing.oid === blob && existing.mode === '100644') return null;
        if (existing !== undefined) entries[index] = replacement;
        else entries.push(replacement);
      }
    } else {
      const childTree = existing?.mode === '40000' ? existing.oid : this.putObject(repo, 'tree', Buffer.alloc(0));
      const child = this.writeTreePath(repo, childTree, segments.slice(1), blob);
      if (child === null) return null;
      replacement = { mode: '40000', name, oid: child };
      if (existing !== undefined) entries[index] = replacement;
      else entries.push(replacement);
    }
    return this.putObject(repo, 'tree', buildTree(entries));
  }

  /** Every commit reachable from `tip`, newest first. */
  commitLog(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = this.commitView(repo, oid);
      if (view === undefined) continue;
      out.push(oid);
      for (const parent of view.parents) queue.push(parent);
    }
    return out;
  }

  /** Whether `ancestor` is reachable from `descendant` (git's fast-forward test). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (process.env.GIT_DEBUG) { const o = repo.objects.get(descendant); try { appendFileSync('/tmp/gitdebug.log', `[anc] anc=${ancestor.slice(0,8)} desc=${descendant.slice(0,8)} type=${o ? o.type : 'MISSING'} parents=${o && o.type==='commit' ? parseCommit(o.data).parents.map(x=>x.slice(0,8)).join(',') || 'NONE' : '-'}\n`); } catch {} }
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue: string[] = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (oid === ancestor) return true;
      const view = this.commitView(repo, oid);
      if (view === undefined) continue;
      for (const parent of view.parents) if (!seen.has(parent)) queue.push(parent);
    }
    return false;
  }

  /** The best common ancestor of two commits (first found walking both histories), or null. */
  mergeBase(repo: Repo, left: string, right: string): string | null {
    const leftAncestors: string[] = this.commitLog(repo, left);
    if (leftAncestors.length === 0) return null;
    const leftSet = new Set(leftAncestors);
    let best: string | null = null;
    for (const candidate of this.commitLog(repo, right)) {
      if (leftSet.has(candidate)) {
        best = candidate;
        break;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ tree diffs

  /** Flatten a tree into path → blob entry (directories are not listed). */
  flatten(repo: Repo, treeOid: string | undefined, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    if (treeOid === undefined) return out;
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flatten(repo, entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  blobText(repo: Repo, oid: string): string {
    return repo.objects.get(oid)?.data.toString('utf8') ?? '';
  }

  /** The changed paths between two commits, with status and line counts. */
  diffCommits(repo: Repo, baseCommit: string | undefined, headCommit: string | undefined) {
    const baseTree = baseCommit === undefined ? undefined : this.commitView(repo, baseCommit)?.tree;
    const headTree = headCommit === undefined ? undefined : this.commitView(repo, headCommit)?.tree;
    const base = this.flatten(repo, baseTree);
    const head = this.flatten(repo, headTree);
    const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; blob_url?: string }> = [];
    for (const [path, entry] of head) {
      const before = base.get(path);
      if (before === undefined) {
        const lines = this.blobText(repo, entry.oid).split('\n').length;
        files.push({ filename: path, status: 'added', additions: Math.max(1, lines - 1), deletions: 0, changes: Math.max(1, lines - 1) });
        continue;
      }
      if (before.oid === entry.oid) continue;
      const after = this.blobText(repo, entry.oid).split('\n');
      const old = this.blobText(repo, before.oid).split('\n');
      let additions = 0;
      let deletions = 0;
      const afterSet = new Set(after);
      const oldSet = new Set(old);
      for (const line of after) if (!oldSet.has(line)) additions += 1;
      for (const line of old) if (!afterSet.has(line)) deletions += 1;
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
    for (const [path] of base) {
      if (!head.has(path)) {
        const lines = this.blobText(repo, base.get(path)!.oid).split('\n').length;
        files.push({ filename: path, status: 'removed', additions: 0, deletions: Math.max(1, lines - 1), changes: Math.max(1, lines - 1) });
      }
    }
    files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return files;
  }

  /** Paths whose blobs differ between two commits. */
  changedPaths(repo: Repo, baseCommit: string | undefined, headCommit: string | undefined): Set<string> {
    return new Set(this.diffCommits(repo, baseCommit, headCommit).map((file) => file.filename));
  }
}

/** The process-wide store: one trial, one process, one store. */
export const store = new Store(process.env.MAKEFUN_LOGIN ?? 'adaiversen');
export { nowIso };
