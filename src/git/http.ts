// git smart HTTP: info/refs advertisements (v0 for receive-pack, v0+v2 for upload-pack), v2 ls-refs and
// fetch, v0 fetch, and receive-pack with per-ref fast-forward enforcement and report-status.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendFileSync } from 'node:fs';
import { bearer, sendError } from '../http.ts';
import { readPack, writePack } from './pack.ts';
import { DELIM, FLUSH, dataLines, decode, pkt, sideband } from './pktline.ts';
import { parseCommit, parseTag, parseTree } from './objects.ts';
import type { GitObject, ObjType } from './objects.ts';
import type { Repo } from '../store.ts';
import { store } from '../store.ts';

const ZERO = '0'.repeat(40);
const AGENT = 'makefun-forge/1.0';
const UPLOAD_ADV = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_ADV = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const UPLOAD_CAPS = [
  'multi_ack_detailed',
  'thin-pack',
  'side-band-64k',
  'ofs-delta',
  'shallow',
  'no-progress',
  'include-tag',
  `agent=${AGENT}`,
];
const RECEIVE_CAPS = ['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`];

/** Every ref of a repo that participates in an advertisement, HEAD first. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  const heads = [...repo.refs.entries()].filter(([name]) => name.startsWith('refs/heads/')).sort(([a], [b]) => (a < b ? -1 : 1));
  const tags = [...repo.refs.entries()].filter(([name]) => name.startsWith('refs/tags/')).sort(([a], [b]) => (a < b ? -1 : 1));
  return [...heads, ...tags];
}

/** The commit a ref peels to (an annotated tag's target, recursively), or the ref's own object. */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    const target = parseTag(object.data).object;
    if (target === '') return current;
    current = target;
  }
  return current;
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const caps = (service === 'git-receive-pack' ? RECEIVE_CAPS : [...UPLOAD_CAPS, `symref=HEAD:refs/heads/${repo.defaultBranch}`]).join(' ');
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const lines: string[] = [];
  if (headOid !== undefined) lines.push(`${headOid} HEAD`);
  for (const [name, oid] of refs) {
    lines.push(`${oid} ${name}`);
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') lines.push(`${peelToCommit(repo, oid)} ${name}^{}`);
  }
  if (lines.length === 0) {
    parts.push(pkt(`${ZERO} capabilities^{}\u0000${caps}\n`));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  parts.push(pkt(`${lines[0]}\u0000${caps}\n`));
  for (const line of lines.slice(1)) parts.push(pkt(`${line}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [
    pkt('# service=git-upload-pack\n'),
    FLUSH,
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done\n'),
    pkt('server-option\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ];
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ ls-refs (protocol v2)

function lsRefs(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length).trim());
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (matches('HEAD')) {
    if (headOid === undefined) {
      if (unborn) parts.push(pkt(symrefs ? `unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : 'unborn HEAD\n'));
    } else {
      parts.push(pkt(symrefs ? `${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${headOid} HEAD\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    const object = repo.objects.get(oid);
    const isTag = object !== undefined && object.type === 'tag';
    const attributes: string[] = [];
    if (peel && isTag) attributes.push(`peeled:${peelToCommit(repo, oid)}`);
    parts.push(pkt(`${oid} ${name}${attributes.length > 0 ? ` ${attributes.join(' ')}` : ''}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch object selection

function treeClosure(repo: Repo, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const object = repo.objects.get(treeOid);
  if (object === undefined) return;
  into.add(treeOid);
  if (object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '160000') continue;
    treeClosure(repo, entry.oid, into);
  }
}

function fullClosure(repo: Repo, root: string, into: Set<string>, stopAt?: Set<string>): void {
  const queue: string[] = [root];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (into.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    into.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      if (view.tree !== '') treeClosure(repo, view.tree, into);
      // A shallow client does not hold this commit's ancestors, so they are not "have"s.
      if (stopAt === undefined || !stopAt.has(oid)) for (const parent of view.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target !== '') queue.push(target);
    } else if (object.type === 'tree') {
      treeClosure(repo, oid, into);
    }
  }
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Which objects a fetch delivers: the wants' closure (depth-limited when shallow), minus the haves'. */
function planFetch(repo: Repo, wants: string[], haves: string[], shallowRequest: string[], depth: number | null): FetchPlan {
  const excluded = new Set<string>();
  const boundary = new Set(shallowRequest);
  for (const have of haves) fullClosure(repo, have, excluded, boundary);

  const wanted = new Set<string>();
  const commitOrder: string[] = [];
  if (depth === null) {
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (object === undefined) continue;
      fullClosure(repo, want, wanted);
    }
  } else {
    let frontier = wants.filter((want) => repo.objects.has(want));
    for (let level = 0; level < depth && frontier.length > 0; level += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (wanted.has(oid)) continue;
        const object = repo.objects.get(oid);
        if (object === undefined) continue;
        if (object.type === 'commit') {
          wanted.add(oid);
          commitOrder.push(oid);
          const view = parseCommit(object.data);
          if (view.tree !== '') treeClosure(repo, view.tree, wanted);
          for (const parent of view.parents) next.push(parent);
        } else if (object.type === 'tag') {
          wanted.add(oid);
          const target = parseTag(object.data).object;
          if (target !== '') next.push(target);
        } else {
          wanted.add(oid);
        }
      }
      frontier = next;
    }
  }

  const shallow: string[] = [];
  for (const oid of commitOrder) {
    const view = store.commitView(repo, oid);
    if (view === undefined) continue;
    if (view.parents.some((parent) => !wanted.has(parent))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const oid of shallowRequest) {
    if (!wanted.has(oid)) continue;
    const view = store.commitView(repo, oid);
    if (view === undefined) continue;
    if (view.parents.every((parent) => wanted.has(parent))) unshallow.push(oid);
  }

  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (excluded.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  if (process.env.GIT_DEBUG) { try { appendFileSync('/tmp/gitdebug.log', `[plan] ${repo.owner}/${repo.name} wants=${wants.length} wanted=${wanted.size} excluded=${excluded.size} objects=${objects.length} types=${objects.map((o:any)=>o.type).join(',')}\n`); } catch {} }
  return { objects, shallow, unshallow };
}

function emptyPack(): Buffer {
  return writePack([]);
}

// ------------------------------------------------------------------ v2 upload-pack

function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const { packets } = decode(body);
  const lines = dataLines(packets);
  const command = (lines.find((line) => line.startsWith('command=')) ?? '').slice('command='.length).trim();
  // Arguments follow the delimiter packet; a v2 body may also put them after the command line.
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line !== '') args.push(line);
  }
  if (command === 'ls-refs') return lsRefs(repo, args);
  if (command !== 'fetch') return Buffer.concat([pkt('version 2\n'), FLUSH]);

  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const value = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
  }

  const plan = planFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  if (haves.length > 0) {
    parts.push(pkt(`ACK ${haves[haves.length - 1]} common\n`));
  } else {
    parts.push(pkt('NAK\n'));
  }
  parts.push(pkt('ready\n'), DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  const pack = plan.objects.length === 0 ? emptyPack() : writePack(plan.objects);
  parts.push(sideband(1, pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ v0 upload-pack

function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const { packets } = decode(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    if (clean.startsWith('want ')) {
      const rest = clean.slice(5).trim();
      const space = rest.indexOf(' ');
      wants.push(space < 0 ? rest : rest.slice(0, space));
    } else if (clean.startsWith('have ')) haves.push(clean.slice(5).trim());
    else if (clean.startsWith('shallow ')) shallow.push(clean.slice(8).trim());
    else if (clean.startsWith('deepen ')) {
      const value = Number.parseInt(clean.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
  }
  if (wants.length === 0) return Buffer.concat([pkt('NAK\n'), FLUSH]);
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt(haves.length > 0 ? `ACK ${haves[haves.length - 1]}\n` : 'NAK\n'));
  const pack = plan.objects.length === 0 ? emptyPack() : writePack(plan.objects);
  parts.push(sideband(1, pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack (v0 only)

interface Command {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseCommands(packets: ReturnType<typeof decode>['packets']): { commands: Command[]; capabilities: string[] } {
  const commands: Command[] = [];
  const capabilities: string[] = [];
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') break;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        capabilities.push(...line.slice(nul + 1).split(' ').filter((cap) => cap !== ''));
        line = line.slice(0, nul);
      }
      first = false;
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (match !== null) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  return { commands, capabilities };
}

function reportStatus(lines: string[], sidebanded: boolean, tag = ''): Buffer {
  if (process.env.GIT_DEBUG) { try { appendFileSync('/tmp/gitdebug.log', `[report] ${tag} sideband=${sidebanded} lines=${JSON.stringify(lines)}\n`); } catch {} }
  const inner: Buffer[] = [];
  for (const line of lines) inner.push(pkt(`${line}\n`));
  inner.push(FLUSH);
  const framed = Buffer.concat(inner);
  if (!sidebanded) return Buffer.concat([framed, FLUSH]);
  return Buffer.concat([sideband(1, framed), FLUSH]);
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = decode(body);
  const { commands, capabilities } = parseCommands(packets);
  const wantsSideband = capabilities.includes('side-band-64k');
  const lines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const read = readPack(rest, (oid) => repo.objects.get(oid));
      if (process.env.GIT_DEBUG) { try { appendFileSync('/tmp/gitdebug.log', `[unpack] ${repo.owner}/${repo.name} objects=${read.objects.size} types=${[...read.objects.values()].map((o:any)=>o.type).join(',')}\n`); } catch {} }
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = `index-pack failed: ${(err as Error).message}`;
    }
  }
  lines.push(`unpack ${unpackDetail}`);
  for (const command of commands) {
    if (!command.ref.startsWith('refs/') || /[\s\u0000-\u001f]/.test(command.ref)) {
      lines.push(`ng ${command.ref} funky ref name`);
      continue;
    }
    if (command.newOid === ZERO) {
      repo.refs.delete(command.ref);
      lines.push(`ok ${command.ref}`);
      continue;
    }
    if (!unpackOk) {
      lines.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    if (repo.objects.get(command.newOid) === undefined) {
      lines.push(`ng ${command.ref} missing necessary objects`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (process.env.GIT_DEBUG) { try { appendFileSync('/tmp/gitdebug.log', `[ref] ${repo.owner}/${repo.name} ${command.ref} old=${command.oldOid.slice(0,8)} new=${command.newOid.slice(0,8)} cur=${current === undefined ? 'none' : current.slice(0,8)}\n`); } catch {} }
    if (command.oldOid !== ZERO && current !== undefined && current !== command.oldOid) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      if (process.env.GIT_DEBUG) { try { appendFileSync('/tmp/gitdebug.log', `[ng1] ${repo.owner}/${repo.name} ${command.ref} old=${command.oldOid.slice(0,8)} cur=${current === undefined ? 'none' : current.slice(0,8)}\n`); } catch {} }
      continue;
    }
    if (command.oldOid !== ZERO && command.newOid !== command.oldOid && !store.isAncestor(repo, command.oldOid, command.newOid)) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      if (process.env.GIT_DEBUG) { try { appendFileSync('/tmp/gitdebug.log', `[ng2] ${repo.owner}/${repo.name} ${command.ref} old=${command.oldOid.slice(0,8)} new=${command.newOid.slice(0,8)}\n`); } catch {} }
      continue;
    }
    if (command.oldOid === ZERO && current !== undefined && !store.isAncestor(repo, current, command.newOid)) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      if (process.env.GIT_DEBUG) { try { appendFileSync('/tmp/gitdebug.log', `[ng3] ${repo.owner}/${repo.name} ${command.ref} cur=${current === undefined ? 'none' : current.slice(0,8)} new=${command.newOid.slice(0,8)}\n`); } catch {} }
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}`);
  }
  return reportStatus(lines, wantsSideband, `${repo.owner}/${repo.name}`);
}

// ------------------------------------------------------------------ routing

const PATH_RE = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git(\/.*)$/;

/** Handle a smart-HTTP request; false when the path is not a git path. */
export function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): boolean {
  const match = PATH_RE.exec(url.pathname);
  if (match === null) return false;
  const owner = match[1];
  const name = match[2];
  const suffix = match[3];
  if (suffix !== '/info/refs' && suffix !== '/git-upload-pack' && suffix !== '/git-receive-pack') return false;

  if (bearer(req) === null) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  const repo = store.getRepo(owner, name);
  if (repo === undefined || repo.owner.toLowerCase() !== owner.toLowerCase()) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  const method = req.method ?? 'GET';
  if (suffix === '/info/refs') {
    if (method !== 'GET') {
      sendError(res, 405, 'Method Not Allowed');
      return true;
    }
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(res, 403, 'Smart HTTP is the only supported protocol');
      return true;
    }
    const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').toString().includes('version=2');
    const advertisement = wantsV2 ? v2Advertisement(repo) : v0Advertisement(repo, service);
    const type = service === 'git-upload-pack' ? UPLOAD_ADV : RECEIVE_ADV;
    res.writeHead(200, {
      'content-type': type,
      'content-length': advertisement.length,
      'cache-control': 'no-cache',
      'x-github-request-id': `git-${Date.now().toString(16)}-${Math.floor(Math.random() * 1e6).toString(16)}`,
    });
    res.end(advertisement);
    return true;
  }

  if (method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  if (suffix === '/git-upload-pack') {
    let result: Buffer;
    try {
      const isV2 = dataLines(decode(body).packets).some((line) => line.startsWith('command='));
      result = isV2 ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
    } catch {
      result = Buffer.concat([pkt('NAK\n'), FLUSH]);
    }
    res.writeHead(200, {
      'content-type': UPLOAD_RESULT,
      'content-length': result.length,
      'cache-control': 'no-cache',
      'x-github-request-id': `git-${Date.now().toString(16)}-${Math.floor(Math.random() * 1e6).toString(16)}`,
    });
    res.end(result);
    return true;
  }

  let result: Buffer;
  try {
    result = handleReceivePack(repo, body);
  } catch (err) {
    result = reportStatus([`unpack ${(err as Error).message}`], false);
  }
  res.writeHead(200, {
    'content-type': RECEIVE_RESULT,
    'content-length': result.length,
    'cache-control': 'no-cache',
    'x-github-request-id': `git-${Date.now().toString(16)}-${Math.floor(Math.random() * 1e6).toString(16)}`,
  });
  res.end(result);
  return true;
}

export type { ObjType };
