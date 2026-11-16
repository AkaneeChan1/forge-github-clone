// pkt-line framing: 4 hex length bytes then the payload; 0000 flush, 0001 delim, 0002 response-end.
export const PKT_MAX = 65520;

export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  let body = data;
  if (body.length > PKT_MAX - 4) body = body.subarray(0, PKT_MAX - 4);
  const header = Buffer.allocUnsafe(4);
  header.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode as many complete packets as `buffer` holds; `rest` is the unconsumed tail. */
export function decode(buffer: Buffer): { packets: Packet[]; rest: Buffer; malformed: boolean } {
  const packets: Packet[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > buffer.length) break;
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) return { packets, rest: buffer.subarray(offset), malformed: true };
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 3 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset), malformed: false };
}

export function dataLines(packets: Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** Frame bytes as side-band-64k channel-1 packets (the packfile/progress channel). */
export function sideband(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunk = PKT_MAX - 5;
  for (let offset = 0; offset < data.length; offset += chunk) {
    const slice = data.subarray(offset, offset + chunk);
    parts.push(pkt(Buffer.concat([Buffer.from([band]), slice])));
  }
  return Buffer.concat(parts);
}
