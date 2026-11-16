// GraphQL v4: a small document parser plus a resolver table over the same store REST writes to.
// Supports variables, aliases, inline fragments, inline input objects and enum lists, and batching.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearer, parseJsonBody, sendError, sendJson } from './http.ts';
import { mergePull } from './rest.ts';
import { store, type Issue, type Pull, type Repo } from './store.ts';

// ------------------------------------------------------------------ parsing

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<[string, Value]> };

interface Argument {
  name: string;
  value: Value;
}

interface Selection {
  kind: 'field' | 'fragment';
  alias?: string;
  name?: string;
  typeCondition?: string;
  arguments: Argument[];
  selections: Selection[];
}

interface Operation {
  type: 'query' | 'mutation';
  name: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
}

class ParseError extends Error {}

const PUNCT = '{}()[]:!$=@,|';

class Lexer {
  private index = 0;
  readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  private skipIgnored(): void {
    for (;;) {
      const char = this.source[this.index];
      if (char === undefined) return;
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
        this.index += 1;
        continue;
      }
      if (char === '#') {
        while (this.index < this.source.length && this.source[this.index] !== '\n') this.index += 1;
        continue;
      }
      return;
    }
  }

  peek(): string {
    this.skipIgnored();
    if (this.source.startsWith('...', this.index)) return '...';
    return this.source[this.index] ?? '';
  }

  /** The whole next token (peek() only reports its first character). */
  peekToken(): string {
    const saved = this.index;
    const token = this.next();
    this.index = saved;
    return token;
  }

  next(): string {
    this.skipIgnored();
    if (this.source.startsWith('...', this.index)) {
      this.index += 3;
      return '...';
    }
    const char = this.source[this.index];
    if (char === undefined) return '';
    if (PUNCT.includes(char) && char !== ',') {
      this.index += 1;
      return char;
    }
    if (char === '"') {
      let text = '';
      this.index += 1;
      while (this.index < this.source.length && this.source[this.index] !== '"') {
        if (this.source[this.index] === '\\') {
          const esc = this.source[this.index + 1];
          text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc ?? '';
          this.index += 2;
          continue;
        }
        text += this.source[this.index];
        this.index += 1;
      }
      this.index += 1;
      return `"${text}"`;
    }
    let text = '';
    while (this.index < this.source.length) {
      const current = this.source[this.index];
      if (current === undefined) break;
      if (current === ' ' || current === '\t' || current === '\n' || current === '\r' || PUNCT.includes(current)) break;
      text += current;
      this.index += 1;
    }
    return text;
  }
}

function parseValue(lexer: Lexer): Value {
  const token = lexer.peek();
  if (token === '$') {
    lexer.next();
    return { kind: 'variable', name: lexer.next() };
  }
  if (token === '[') {
    lexer.next();
    const values: Value[] = [];
    while (lexer.peek() !== ']' && lexer.peek() !== '') values.push(parseValue(lexer));
    lexer.next();
    return { kind: 'list', values };
  }
  if (token === '{') {
    lexer.next();
    const fields: Array<[string, Value]> = [];
    while (lexer.peek() !== '}' && lexer.peek() !== '') {
      const name = lexer.next();
      if (lexer.peek() === ':') lexer.next();
      fields.push([name, parseValue(lexer)]);
    }
    lexer.next();
    return { kind: 'object', fields };
  }
  const raw = lexer.next();
  if (raw.startsWith('"')) return { kind: 'literal', value: raw.slice(1, -1) };
  if (raw === 'true') return { kind: 'literal', value: true };
  if (raw === 'false') return { kind: 'literal', value: false };
  if (raw === 'null') return { kind: 'literal', value: null };
  const numeric = Number(raw);
  if (raw !== '' && Number.isFinite(numeric)) return { kind: 'literal', value: numeric };
  return { kind: 'literal', value: raw };
}

function parseSelectionSet(lexer: Lexer): Selection[] {
  if (lexer.peek() !== '{') throw new ParseError('ExpectedSelectionSet');
  lexer.next();
  const selections: Selection[] = [];
  while (lexer.peek() !== '}' && lexer.peek() !== '') {
    if (lexer.peek() === '...') {
      lexer.next();
      let typeCondition: string | undefined;
      if (lexer.peekToken() === 'on') {
        lexer.next();
        typeCondition = lexer.next();
      }
      selections.push({ kind: 'fragment', typeCondition, arguments: [], selections: parseSelectionSet(lexer) });
      continue;
    }
    let name = lexer.next();
    let alias: string | undefined;
    if (lexer.peek() === ':') {
      lexer.next();
      alias = name;
      name = lexer.next();
    }
    const args: Argument[] = [];
    if (lexer.peek() === '(') {
      lexer.next();
      while (lexer.peek() !== ')' && lexer.peek() !== '') {
        const argName = lexer.next();
        if (lexer.peek() === ':') lexer.next();
        args.push({ name: argName, value: parseValue(lexer) });
      }
      lexer.next();
    }
    let selections2: Selection[] = [];
    if (lexer.peek() === '{') selections2 = parseSelectionSet(lexer);
    selections.push({ kind: 'field', alias, name, arguments: args, selections: selections2 });
  }
  lexer.next();
  return selections;
}

function parseDocument(source: string): Document {
  const lexer = new Lexer(source);
  const operations: Operation[] = [];
  while (lexer.peek() !== '') {
    const keyword = lexer.peek();
    if (keyword === '{') {
      operations.push({ type: 'query', name: 'anonymous', selections: parseSelectionSet(lexer) });
      continue;
    }
    const type = lexer.next();
    if (type !== 'query' && type !== 'mutation') throw new ParseError(`Unsupported operation ${type}`);
    let name = 'anonymous';
    if (lexer.peek() !== '(' && lexer.peek() !== '{') name = lexer.next();
    if (lexer.peek() === '(') {
      lexer.next();
      let depth = 1;
      while (depth > 0 && lexer.peek() !== '') {
        const token = lexer.next();
        if (token === '(') depth += 1;
        else if (token === ')') depth -= 1;
      }
    }
    operations.push({ type: type as 'query' | 'mutation', name, selections: parseSelectionSet(lexer) });
  }
  if (operations.length === 0) throw new ParseError('Empty document');
  return { operations };
}

// ------------------------------------------------------------------ ids and helpers

function encodeId(kind: string, id: number): string {
  return Buffer.from(`04:${kind}:${id}`).toString('base64');
}

function decodeId(value: string): { kind: string; id: number } | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 3) return null;
    const id = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(id)) return null;
    return { kind: parts[1], id };
  } catch {
    return null;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`).toString('base64');
}

function decodeCursor(value: string | null | undefined): number {
  if (typeof value !== 'string' || value === '') return 0;
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const offset = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

function repoByName(owner: string, name: string): Repo | undefined {
  return store.getRepo(owner, name);
}

function findRepoById(id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function findIssueById(id: number): { repo: Repo; issue: Issue } | null {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
  }
  return null;
}

function findPullById(id: number): { repo: Repo; pull: Pull } | null {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
  }
  return null;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// ------------------------------------------------------------------ schema

interface FieldDef {
  type: string;
  list?: boolean;
  resolve: (source: any, args: Record<string, unknown>, ctx: Context) => unknown;
}

interface Context {
  errors: Array<{ message: string; path?: string[]; type?: string }>;
  viewer: string;
}

const ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  ReactionContent: ['THUMBS_UP', 'THUMBS_DOWN', 'LAUGH', 'HOORAY', 'CONFUSED', 'HEART', 'ROCKET', 'EYES'],
};

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { type: 'User', resolve: (_s, _a, ctx) => ({ login: ctx.viewer }) },
    repository: {
      type: 'Repository',
      resolve: (_s, args) => repoByName(String(args.owner ?? ''), String(args.name ?? '')) ?? null,
    },
    node: { type: 'Node', resolve: (_s, args) => resolveNode(String(args.id ?? '')) },
    __type: { type: '__Type', resolve: (_s, args) => introspectionOf(String(args.name ?? '')) },
  },
  User: {
    login: { type: 'String', resolve: (source) => source.login ?? '' },
    id: { type: 'ID', resolve: (source) => encodeId('User', 1000 + String(source.login ?? '').length) },
    name: { type: 'String', resolve: (source) => source.login ?? '' },
    isViewer: { type: 'Boolean', resolve: (_s, _a, ctx) => true },
  },
  Repository: {
    id: { type: 'ID', resolve: (repo: Repo) => encodeId('Repository', repo.id) },
    databaseId: { type: 'Int', resolve: (repo: Repo) => repo.id },
    name: { type: 'String', resolve: (repo: Repo) => repo.name },
    nameWithOwner: { type: 'String', resolve: (repo: Repo) => `${repo.owner}/${repo.name}` },
    owner: { type: 'User', resolve: (repo: Repo) => ({ login: repo.owner }) },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (repo: Repo) => (repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null),
    },
    viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    isPrivate: { type: 'Boolean', resolve: (repo: Repo) => repo.private },
    description: { type: 'String', resolve: (repo: Repo) => repo.description },
    issue: {
      type: 'Issue',
      resolve: (repo: Repo, args) => repo.issues.get(Number(args.number ?? 0)) ?? null,
    },
    issues: {
      type: 'IssueConnection',
      resolve: (repo: Repo, args, ctx) => issueConnection(repo, args, ctx),
    },
    pullRequests: {
      type: 'PullRequestConnection',
      resolve: (repo: Repo, args) => {
        const first = Math.max(0, Math.min(100, Number(args.first ?? 10)));
        const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
        return { nodes: pulls.slice(0, first) };
      },
    },
    pullRequest: {
      type: 'PullRequest',
      resolve: (repo: Repo, args) => repo.pulls.get(Number(args.number ?? 0)) ?? null,
    },
  },
  Ref: {
    name: { type: 'String', resolve: (source: { name: string }) => source.name },
    target: { type: 'String', resolve: () => '' },
  },
  Issue: {
    id: { type: 'ID', resolve: (issue: Issue) => encodeId('Issue', issue.id) },
    number: { type: 'Int', resolve: (issue: Issue) => issue.number },
    title: { type: 'String', resolve: (issue: Issue) => issue.title },
    state: { type: 'IssueState', resolve: (issue: Issue) => issueState(issue) },
    body: { type: 'String', resolve: (issue: Issue) => issue.body },
    createdAt: { type: 'String', resolve: (issue: Issue) => issue.createdAt },
    labels: { type: 'String', list: true, resolve: (issue: Issue) => issue.labels },
    comments: { type: 'IssueCommentConnection', resolve: (issue: Issue) => ({ nodes: issue.comments }) },
  },
  IssueComment: {
    id: { type: 'ID', resolve: (comment: { id: number }) => encodeId('IssueComment', comment.id) },
    body: { type: 'String', resolve: (comment: { body: string }) => comment.body },
  },
  PullRequest: {
    id: { type: 'ID', resolve: (pull: Pull) => encodeId('PullRequest', pull.id) },
    number: { type: 'Int', resolve: (pull: Pull) => pull.number },
    title: { type: 'String', resolve: (pull: Pull) => pull.title },
    body: { type: 'String', resolve: (pull: Pull) => pull.body },
    state: { type: 'PullRequestState', resolve: (pull: Pull) => pullState(pull) },
    merged: { type: 'Boolean', resolve: (pull: Pull) => pull.merged },
    mergedAt: { type: 'String', resolve: (pull: Pull) => pull.mergedAt },
    headRefName: { type: 'String', resolve: (pull: Pull) => pull.head.ref },
    baseRefName: { type: 'String', resolve: (pull: Pull) => pull.base.ref },
    mergeable: { type: 'MergeableState', resolve: (pull: Pull) => (pull.state === 'open' ? 'MERGEABLE' : 'UNKNOWN') },
    files: {
      type: 'PullRequestChangedFileConnection',
      resolve: (pull: Pull, args) => {
        const repo = findRepoById(Math.floor(pull.id / 100000));
        if (repo === undefined) return { nodes: [] };
        const baseCommit = pull.base.sha === '' ? undefined : pull.base.sha;
        const headCommit = pull.head.sha === '' ? undefined : pull.head.sha;
        const files = store.diffCommits(repo, baseCommit, headCommit);
        const first = Math.max(0, Math.min(100, Number(args.first ?? 100)));
        return { nodes: files.slice(0, first) };
      },
    },
  },
  PullRequestChangedFile: {
    path: { type: 'String', resolve: (file: { filename: string }) => file.filename },
    additions: { type: 'Int', resolve: (file: { additions: number }) => file.additions },
    deletions: { type: 'Int', resolve: (file: { deletions: number }) => file.deletions },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: 'PullRequestChangedFile', list: true, resolve: (source: { nodes: unknown[] }) => source.nodes },
    totalCount: { type: 'Int', resolve: (source: { nodes: unknown[] }) => source.nodes.length },
  },
  IssueConnection: {
    nodes: { type: 'Issue', list: true, resolve: (source: { nodes: Issue[] }) => source.nodes },
    totalCount: { type: 'Int', resolve: (source: { total: number }) => source.total },
    pageInfo: { type: 'PageInfo', resolve: (source: { pageInfo: unknown }) => source.pageInfo },
  },
  IssueCommentConnection: {
    nodes: { type: 'IssueComment', list: true, resolve: (source: { nodes: unknown[] }) => source.nodes },
  },
  PullRequestConnection: {
    nodes: { type: 'PullRequest', list: true, resolve: (source: { nodes: unknown[] }) => source.nodes },
    totalCount: { type: 'Int', resolve: (source: { nodes: unknown[] }) => source.nodes.length },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean', resolve: (source: { hasNextPage: boolean }) => source.hasNextPage },
    hasPreviousPage: { type: 'Boolean', resolve: () => false },
    endCursor: { type: 'String', resolve: (source: { endCursor: string | null }) => source.endCursor },
    startCursor: { type: 'String', resolve: () => null },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeId(String(input.repositoryId ?? ''));
        const repo = decoded === null ? undefined : findRepoById(decoded.id);
        if (repo === undefined) {
          ctx.errors.push({ message: 'Could not resolve to a Repository with the global id' });
          return null;
        }
        const issue = store.createIssue(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          labels: [],
          author: ctx.viewer,
        });
        return { issue };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeId(String(input.issueId ?? ''));
        const found = decoded === null ? null : findIssueById(decoded.id);
        if (found === null) {
          ctx.errors.push({ message: 'Could not resolve to an Issue with the global id' });
          return null;
        }
        found.issue.state = 'closed';
        found.issue.updatedAt = new Date().toISOString();
        return { issue: found.issue };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeId(String(input.repositoryId ?? ''));
        const repo = decoded === null ? undefined : findRepoById(decoded.id);
        if (repo === undefined) {
          ctx.errors.push({ message: 'Could not resolve to a Repository with the global id' });
          return null;
        }
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? repo.defaultBranch);
        if (!repo.refs.has(`refs/heads/${head}`)) {
          ctx.errors.push({ message: `No commits between ${base} and ${head}` });
          return null;
        }
        const pull = store.createPull(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          head,
          base,
          author: ctx.viewer,
        });
        return { pullRequest: pull };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeId(String(input.pullRequestId ?? ''));
        const found = decoded === null ? null : findPullById(decoded.id);
        if (found === null) {
          ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id' });
          return null;
        }
        const result = mergePull(found.repo, found.pull, String(input.mergeMethod ?? 'SQUASH').toLowerCase());
        if (result.status !== 200) {
          ctx.errors.push({ message: 'Pull request is not mergeable' });
          return null;
        }
        return { pullRequest: found.pull };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeId(String(input.subjectId ?? ''));
        const found = decoded === null ? null : findIssueById(decoded.id);
        if (found === null) {
          ctx.errors.push({ message: 'Could not resolve to an Issue with the global id' });
          return null;
        }
        const comment = store.createComment(found.repo, found.issue, String(input.body ?? ''), ctx.viewer);
        return { commentEdge: { node: comment } };
      },
    },
  },
  CreateIssuePayload: { issue: { type: 'Issue', resolve: (source: { issue: Issue }) => source.issue } },
  CloseIssuePayload: { issue: { type: 'Issue', resolve: (source: { issue: Issue }) => source.issue } },
  CreatePullRequestPayload: { pullRequest: { type: 'PullRequest', resolve: (source: { pullRequest: Pull }) => source.pullRequest } },
  MergePullRequestPayload: { pullRequest: { type: 'PullRequest', resolve: (source: { pullRequest: Pull }) => source.pullRequest } },
  AddCommentPayload: {
    commentEdge: { type: 'IssueCommentEdge', resolve: (source: { commentEdge: unknown }) => source.commentEdge },
    clientMutationId: { type: 'String', resolve: () => null },
  },
  IssueCommentEdge: { node: { type: 'IssueComment', resolve: (source: { node: unknown }) => source.node } },
  __Type: {
    name: { type: 'String', resolve: (source: { name: string }) => source.name },
    kind: { type: 'String', resolve: () => 'OBJECT' },
    description: { type: 'String', resolve: () => null },
    fields: {
      type: '__Field',
      list: true,
      resolve: (source: { fields: string[] }) => source.fields.map((name) => ({ name })),
    },
    enumValues: {
      type: '__EnumValue',
      list: true,
      resolve: (source: { enumValues: string[] }) => source.enumValues.map((name) => ({ name })),
    },
  },
  __Field: {
    name: { type: 'String', resolve: (source: { name: string }) => source.name },
    type: { type: 'String', resolve: () => 'String' },
  },
  __EnumValue: { name: { type: 'String', resolve: (source: { name: string }) => source.name } },
};

/** The union type Node: the concrete type travels with the value. */
function resolveNode(id: string): { __typename: string; value: unknown } | null {
  const decoded = decodeId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = findRepoById(decoded.id);
    if (repo === undefined) return null;
    return { __typename: 'Repository', value: repo };
  }
  if (decoded.kind === 'Issue') {
    const found = findIssueById(decoded.id);
    return found === null ? null : { __typename: 'Issue', value: found.issue };
  }
  if (decoded.kind === 'PullRequest') {
    const found = findPullById(decoded.id);
    return found === null ? null : { __typename: 'PullRequest', value: found.pull };
  }
  return null;
}

function introspectionOf(name: string): { name: string; fields: string[]; enumValues: string[] } | null {
  const fields = SCHEMA[name];
  const enums = ENUMS[name];
  if (fields === undefined && enums === undefined) return null;
  return { name, fields: fields === undefined ? [] : Object.keys(fields), enumValues: enums ?? [] };
}

function issueConnection(repo: Repo, args: Record<string, unknown>, ctx: Context) {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = states.map((state) => String(state));
    issues = issues.filter((issue) => wanted.includes(issueState(issue)));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = String(orderBy.field ?? 'CREATED_AT');
  const direction = String(orderBy.direction ?? 'DESC');
  issues.sort((a, b) => {
    let delta = 0;
    if (field === 'UPDATED_AT') delta = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else if (field === 'COMMENTS') delta = a.comments.length - b.comments.length;
    else delta = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    if (delta === 0) delta = a.number - b.number;
    return direction === 'ASC' ? delta : -delta;
  });
  const total = issues.length;
  const first = args.first === undefined || args.first === null ? 10 : Math.max(0, Math.min(100, Number(args.first)));
  const after = decodeCursor(args.after as string | null | undefined);
  const start = args.after === undefined || args.after === null ? 0 : after + 1;
  const page = issues.slice(start, start + first);
  const hasNextPage = start + page.length < total;
  const endCursor = page.length === 0 ? null : encodeCursor(start + page.length - 1);
  void ctx;
  return { nodes: page, total, pageInfo: { hasNextPage, endCursor } };
}

// ------------------------------------------------------------------ execution

function valueOf(value: Value, variables: Record<string, unknown>): unknown {
  if (value.kind === 'variable') return variables[value.name];
  if (value.kind === 'literal') return value.value;
  if (value.kind === 'list') return value.values.map((entry) => valueOf(entry, variables));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of value.fields) out[key] = valueOf(entry, variables);
  return out;
}

function argumentsOf(selection: Selection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const argument of selection.arguments) out[argument.name] = valueOf(argument.value, variables);
  return out;
}

function resolveSelections(typeName: string, source: unknown, selections: Selection[], ctx: Context, variables: Record<string, unknown>): Record<string, unknown> | null {
  if (source === null || source === undefined) return null;
  let effectiveType = typeName;
  let effectiveSource: unknown = source;
  if (typeName === 'Node') {
    const node = source as { __typename: string; value: unknown };
    effectiveType = node.__typename;
    effectiveSource = node.value;
  }
  const fields = SCHEMA[effectiveType];
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== effectiveType) continue;
      const nested = resolveSelections(effectiveType, effectiveSource, selection.selections, ctx, variables);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const name = selection.name ?? '';
    const key = selection.alias ?? name;
    if (name === '__typename') {
      out[key] = effectiveType;
      continue;
    }
    const definition = fields?.[name];
    if (definition === undefined) {
      ctx.errors.push({ message: `Cannot query field "${name}" on type "${effectiveType}".`, type: effectiveType });
      out[key] = null;
      continue;
    }
    const args = argumentsOf(selection, variables);
    let value: unknown;
    try {
      value = definition.resolve(effectiveSource, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: (err as Error).message });
      out[key] = null;
      continue;
    }
    if (selection.selections.length === 0) {
      out[key] = value === undefined ? null : value;
      continue;
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (definition.list === true) {
      if (!Array.isArray(value)) {
        out[key] = [];
        continue;
      }
      out[key] = value.map((entry) => resolveSelections(definition.type, entry, selection.selections, ctx, variables));
      continue;
    }
    out[key] = resolveSelections(definition.type, value, selection.selections, ctx, variables);
  }
  return out;
}

function execute(query: string, variables: Record<string, unknown>, viewer: string): Record<string, unknown> {
  let document: Document;
  try {
    document = parseDocument(query);
  } catch (err) {
    return { errors: [{ message: `Parse error: ${(err as Error).message}` }], data: null };
  }
  const results: Record<string, unknown>[] = [];
  for (const operation of document.operations) {
    const ctx: Context = { errors: [], viewer };
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = resolveSelections(rootType, {}, operation.selections, ctx, variables);
    const result: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) result.errors = ctx.errors;
    results.push(result);
  }
  return results[0] ?? { data: null };
}

/** POST /api/graphql: one document or an array of them, with the bearer token. */
export function handleGraphqlSkeleton(): void {
  // replaced below
}

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): Promise<boolean> {
  if (url.pathname !== '/api/graphql' && url.pathname !== '/api/graphql/') return false;
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  if (bearer(req) === null) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let payload: unknown;
  try {
    payload = parseJsonBody(body);
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  if (Array.isArray(payload)) {
    const answers = payload.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return execute(String(item.query ?? ''), (item.variables ?? {}) as Record<string, unknown>, store.login);
    });
    sendJson(res, 200, answers);
    return true;
  }
  const item = (payload ?? {}) as Record<string, unknown>;
  const answer = execute(String(item.query ?? ''), (item.variables ?? {}) as Record<string, unknown>, store.login);
  sendJson(res, 200, answer);
  return true;
}
