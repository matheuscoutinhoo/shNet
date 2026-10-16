import {
  createQuorumNode,
  receiveQuorum,
  tickQuorum,
  proposeQuorum,
  type QuorumState,
  type QuorumMessage,
  type QuorumResult,
} from '../../packages/simulation-engine/src/protocols/quorum';

export class Cluster {
  nodes: Record<string, QuorumState> = {};
  messages: QuorumMessage[] = [];
  blocked = new Set<string>();
  stopped = new Set<string>();
  now = 0;
  constructor(members = ['a', 'b', 'c']) {
    members.forEach(
      (self, seed) => (this.nodes[self] = createQuorumNode({ cluster: 'lab', self, members, seed: seed + 1 }))
    );
  }
  accept(result: QuorumResult) {
    this.nodes[result.state.self] = result.state;
    this.messages.push(...result.messages);
  }
  deliver(reverse = false, duplicate = false) {
    let remaining = 10000;
    while (this.messages.length) {
      if (--remaining === 0) throw new Error('Message storm');
      const message = reverse ? this.messages.pop()! : this.messages.shift()!;
      if (
        this.stopped.has(message.to) ||
        this.stopped.has(message.from) ||
        this.blocked.has(`${message.from}:${message.to}`)
      )
        continue;
      this.accept(receiveQuorum(this.nodes[message.to], message, this.now));
      if (duplicate) this.accept(receiveQuorum(this.nodes[message.to], message, this.now));
    }
  }
  advance(ms: number, reverse = false, duplicate = false) {
    const end = this.now + ms;
    while (this.now < end) {
      this.now += Math.min(10, end - this.now);
      for (const node of Object.values(this.nodes))
        if (!this.stopped.has(node.self)) this.accept(tickQuorum(node, this.now));
      this.deliver(reverse, duplicate);
    }
  }
  leader(exclude?: string) {
    const node = Object.values(this.nodes).find(
      (n) => n.role === 'leader' && !this.stopped.has(n.self) && n.self !== exclude
    );
    if (!node) throw new Error('No leader');
    return node;
  }
  partition(member: string) {
    for (const other of Object.keys(this.nodes).filter((p) => p !== member)) {
      this.blocked.add(`${member}:${other}`);
      this.blocked.add(`${other}:${member}`);
    }
  }
  put(node: string, key: string, value: string) {
    const result = proposeQuorum(this.nodes[node], { kind: 'put', key, value });
    this.accept(result);
    return result.index;
  }
}
