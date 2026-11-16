// MCP endpoint: JSON-RPC 2.0 over POST /mcp, the 2026-07-28 revision (server/discover) and the
// initialize handshake both answered, with eight tools over the same store REST serves.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearer, sendJson } from './http.ts';
import { mergePull } from './rest.ts';
import { store, type Repo } from './store.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const PREFERRED = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => unknown;
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function repoOf(args: Record<string, unknown>): Repo | undefined {
  const owner = text(args.owner) || store.login;
  const name = text(args.repo) || text(args.name);
  return store.getRepo(owner, name);
}

function repoSummary(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: repo.owner,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
  };
}

function issueSummary(repo: Repo, issue: { number: number; title: string; body: string; state: string; id: number; labels: string[] }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    repository: `${repo.owner}/${repo.name}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullSummary(repo: Repo, pull: { number: number; title: string; body: string; state: string; merged: boolean; head: { ref: string; sha: string }; base: { ref: string; sha: string } }): Record<string, unknown> {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: pull.head.ref,
    base: pull.base.ref,
    head_sha: pull.head.sha,
    base_sha: pull.base.sha,
    repository: `${repo.owner}/${repo.name}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user and return it.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user).' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      ['name'],
    ),
    run: (args) => {
      const name = text(args.name).trim();
      if (name === '') throw new Error('name is required');
      const existing = store.getRepo(store.login, name);
      if (existing !== undefined) return repoSummary(existing);
      const repo = store.createRepo(store.login, name, {
        description: text(args.description),
        private: args.private === true,
      });
      return repoSummary(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      ['owner', 'repo'],
    ),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === undefined) throw new Error(`repository ${text(args.owner)}/${text(args.repo)} not found`);
      return repoSummary(repo);
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names that already exist on the repository.' },
      },
      ['owner', 'repo', 'title'],
    ),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === undefined) throw new Error(`repository ${text(args.owner)}/${text(args.repo)} not found`);
      const title = text(args.title);
      if (title === '') throw new Error('title is required');
      const labels = Array.isArray(args.labels) ? args.labels.filter((entry): entry is string => typeof entry === 'string') : [];
      const issue = store.createIssue(repo, { title, body: text(args.body), labels });
      return issueSummary(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, newest first.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter.' },
      },
      ['owner', 'repo'],
    ),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === undefined) throw new Error(`repository ${text(args.owner)}/${text(args.repo)} not found`);
      const state = text(args.state) || 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueSummary(repo, issue));
      return { repository: `${repo.owner}/${repo.name}`, total: issues.length, issues };
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        number: { type: 'number', description: 'Issue number.' },
      },
      ['owner', 'repo', 'number'],
    ),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === undefined) throw new Error(`repository ${text(args.owner)}/${text(args.repo)} not found`);
      const issue = repo.issues.get(Number(args.number));
      if (issue === undefined) throw new Error(`issue #${String(args.number)} not found`);
      return issueSummary(repo, issue);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Source branch name.' },
        base: { type: 'string', description: 'Target branch name.' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === undefined) throw new Error(`repository ${text(args.owner)}/${text(args.repo)} not found`);
      const head = text(args.head);
      const base = text(args.base) || repo.defaultBranch;
      if (!repo.refs.has(`refs/heads/${head}`)) throw new Error(`head branch ${head} does not exist`);
      const pull = store.createPull(repo, { title: text(args.title), body: text(args.body), head, base });
      return pullSummary(repo, pull);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Pull request state filter.' },
      },
      ['owner', 'repo'],
    ),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === undefined) throw new Error(`repository ${text(args.owner)}/${text(args.repo)} not found`);
      const state = text(args.state) || 'open';
      const pulls = [...repo.pulls.values()]
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => b.number - a.number)
        .map((pull) => pullSummary(repo, pull));
      return { repository: `${repo.owner}/${repo.name}`, total: pulls.length, pull_requests: pulls };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge strategy.' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === undefined) throw new Error(`repository ${text(args.owner)}/${text(args.repo)} not found`);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) throw new Error(`pull request #${String(args.pull_number)} not found`);
      const result = mergePull(repo, pull, text(args.merge_method) || 'squash');
      if (result.status !== 200) throw new Error(`pull request #${pull.number} is not mergeable`);
      return { ...pullSummary(repo, pull), merged: true, sha: pull.mergeCommitSha, message: 'Pull Request successfully merged' };
    },
  },
];

const TOOL_INDEX = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** The tools array, serialized once so two tools/list answers are byte-identical. */
const TOOLS_PAYLOAD = TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function callTool(params: Record<string, unknown>): Record<string, unknown> {
  const name = text(params.name);
  const tool = TOOL_INDEX.get(name);
  if (tool === undefined) return rpcError(null, -32602, `Unknown tool: ${name}`);
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const required = Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]) : [];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length > 0) return rpcError(null, -32602, `Missing required arguments: ${missing.join(', ')}`);
  try {
    const payload = tool.run(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
}

function handleOne(request: RpcRequest): { status: number; body: Record<string, unknown> | null } {
  const method = text(request.method);
  const id = request.id;
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (method === '') return { status: 200, body: rpcError(id, -32600, 'Invalid Request') };
  if (method.startsWith('notifications/')) return { status: 202, body: null };
  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        protocolVersion: PREFERRED,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }),
    };
  }
  if (method === 'initialize') {
    const offered = text(params.protocolVersion);
    const chosen = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-06-18';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
      }),
    };
  }
  if (method === 'ping') return { status: 200, body: rpcResult(id, {}) };
  if (method === 'tools/list') return { status: 200, body: rpcResult(id, { tools: TOOLS_PAYLOAD }) };
  if (method === 'tools/call') {
    const outcome = callTool(params);
    if ('error' in outcome) {
      const error = outcome.error as { code: number; message: string };
      return { status: 200, body: rpcError(id, error.code, error.message) };
    }
    return { status: 200, body: rpcResult(id, outcome) };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

/** POST /mcp: one JSON-RPC request, or a batch of them. */
export function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): boolean {
  if (url.pathname !== '/mcp' && url.pathname !== '/mcp/') return false;
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } }, { allow: 'POST' });
    return true;
  }
  if (bearer(req) === null) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: a bearer token is required' } }, { 'www-authenticate': 'Bearer' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const entry of parsed) {
      const outcome = handleOne((entry ?? {}) as RpcRequest);
      if (outcome.body !== null) answers.push(outcome.body);
    }
    if (answers.length === 0) {
      res.writeHead(202, { 'x-github-request-id': `mcp-${Date.now().toString(16)}` });
      res.end();
      return true;
    }
    sendJson(res, 200, answers);
    return true;
  }
  const outcome = handleOne((parsed ?? {}) as RpcRequest);
  if (outcome.body === null) {
    res.writeHead(202, { 'x-github-request-id': `mcp-${Date.now().toString(16)}` });
    res.end();
    return true;
  }
  sendJson(res, outcome.status, outcome.body);
  return true;
}
