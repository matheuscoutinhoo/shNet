import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { exportPcap, encodeEthernet, ENGINE_CONTRACT_VERSION } from '../packages/simulation-engine/src';
import { syslogCaptureFixture } from '../tests/fixtures/syslog-captures';
import { engineSourceHash } from './engine-build';
const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/syslog-captures-2026-10-15';
await mkdir(out, { recursive: true });
const { engine, restored, collector } = syslogCaptureFixture(),
  snapshot = engine.snapshot(),
  capture = exportPcap(snapshot);
assert.deepEqual(snapshot, restored.snapshot());
assert.equal(collector.syslogServer!.entries.length, 3);
assert.equal(capture.excluded.length, 0);
assert.equal(capture.dropped, 0);
const frames = snapshot.capture!.frames.map((event) => {
  const f = event.frame!,
    p = f.packet;
  return {
    time: event.time,
    bytes: encodeEthernet(f).length,
    sourceMac: f.src,
    destinationMac: f.dst,
    ...(p?.protocol === 'UDP' && p.payload.protocol === 'SYSLOG'
      ? {
          source: p.src,
          destination: p.dst,
          sourcePort: p.sourcePort,
          destinationPort: p.destinationPort,
          ipBytes: p.bytes,
          message: p.payload.message,
        }
      : {}),
  };
});
const report = {
  generatedAt: new Date().toISOString(),
  passed: true,
  engineContract: ENGINE_CONTRACT_VERSION,
  engineSourceHash: engineSourceHash(),
  packets: capture.packets,
  dropped: capture.dropped,
  excluded: capture.excluded,
  scope:
    'Native RFC 5424/UDP: PAT, severity filter, ACL, link loss, disabled collector, automatic event and deterministic restore. Timestamp is NILVALUE because the model clock is elapsed virtual time, not UTC. Internal event ID stays in the manifest; MSGID/PROCID/SD are NILVALUE.',
  entries: collector.syslogServer!.entries,
  frames,
};
assert.equal(frames.length, capture.packets);
await writeFile(out + '/syslog.pcap', capture.bytes);
await writeFile(out + '/syslog.shlab.json', JSON.stringify(snapshot));
await writeFile(out + '/captures.json', JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({ passed: true, packets: capture.packets, entries: report.entries.length, output: out })
);
