"""Independent syslog RFC 5424/UTF-8, network fields and checksum checks."""
import json
import shutil
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from scapy.all import Ether, IP, UDP, ICMP, Raw, rdpcap

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'artifacts/syslog-captures-2026-10-15')
manifest = json.loads((root / 'captures.json').read_text(encoding='utf-8'))
packets = rdpcap(str(root / 'syslog.pcap'))
assert len(packets) == manifest['packets'] == len(manifest['frames'])
assert not manifest['excluded'] and manifest['dropped'] == 0 and len(manifest['entries']) == 3
checks = Counter()
messages = []
def payload(m):
    return f"<{m['facility'] * 8 + m['severity']}>1 - {m['hostname']} {m['appName']} - - - ".encode() + b'\xef\xbb\xbf' + m['text'].encode('utf-8')
for packet, expected in zip(packets, manifest['frames']):
    assert len(bytes(packet)) == expected['bytes']
    assert packet[Ether].src == expected['sourceMac'].lower()
    assert packet[Ether].dst == expected['destinationMac'].lower()
    for layer, label in [(IP, 'ipv4Checksums'), (UDP, 'udpChecksums'), (ICMP, 'icmpChecksums')]:
        if layer in packet:
            original = packet[layer].chksum
            copy = packet.copy()
            del copy[layer].chksum
            assert Ether(bytes(copy))[layer].chksum == original
            checks[label] += 1
    if ICMP in packet:
        quoted = bytes(packet[ICMP].payload)
        assert len(quoted) == 28
        words = [int.from_bytes(quoted[i:i + 2], 'big') for i in range(0, 20, 2)]
        total = sum(words)
        while total >> 16:
            total = (total & 65535) + (total >> 16)
        assert total == 65535
        qip = IP(quoted)
        source, destination, length, checksum = [int.from_bytes(quoted[i:i+2], 'big') for i in range(20, 28, 2)]
        assert length >= 8 and qip.len == length + 20
        candidates = [payload(f['message']) for f in manifest['frames'] if 'message' in f and len(payload(f['message'])) + 8 == length]
        assert any(IP(bytes(IP(src=qip.src, dst=qip.dst) / UDP(sport=source, dport=destination) / Raw(data)))[UDP].chksum == checksum for data in candidates)
        checks['quotedUdpChecksums'] += 1
    m = expected.get('message')
    if m is None:
        continue
    assert packet[IP].src == expected['source'] and packet[IP].dst == expected['destination']
    assert packet[IP].len == expected['ipBytes'] == packet[UDP].len + 20
    assert packet[UDP].sport == expected['sourcePort'] and packet[UDP].dport == 514
    raw = bytes(packet[UDP].payload)
    header, body = raw.split(b' ', 7)[:7], raw.split(b' ', 7)[7]
    assert header == [f"<{m['facility'] * 8 + m['severity']}>1".encode(), b'-', m['hostname'].encode(), m['appName'].encode(), b'-', b'-', b'-']
    assert body.startswith(b'\xef\xbb\xbf')
    assert body[3:].decode('utf-8', errors='strict') == m['text']
    assert len(raw) + 28 == expected['ipBytes']
    messages.append(m)
assert messages and not any(m['text'] == 'Debug filtrado' for m in messages)
assert any(m['text'] == 'Negado pela ACL' for m in messages)
assert any(m['text'] == 'Perdido no enlace' for m in messages)
assert not any(e['message']['text'] in ['Negado pela ACL', 'Perdido no enlace', 'Coletor indisponível'] for e in manifest['entries'])
tshark = shutil.which('tshark') or (r'C:\Program Files\Wireshark\tshark.exe' if sys.platform == 'win32' else None)
assert tshark, 'TShark required.'
def run(*args):
    result = subprocess.run([tshark, '-n', '-r', str(root / 'syslog.pcap'), *args], capture_output=True, text=True, encoding='utf-8')
    if result.returncode:
        raise RuntimeError('TShark: ' + result.stderr)
    return result.stdout
registry = subprocess.run([tshark, '-G', 'fields'], capture_output=True, text=True, check=True, encoding='utf-8').stdout
available = {line.split('\t')[2] for line in registry.splitlines() if line.startswith('F\t')}
assert {'syslog.facility', 'syslog.level'} <= available
fields = ['frame.number', 'syslog.facility', 'syslog.level']
extended = [name for name in ['syslog.version', 'syslog.hostname', 'syslog.appname'] if name in available]
fields += extended
malformed_filter = '_ws.malformed'
if 'syslog.msg.nonconformant' in available:
    malformed_filter += ' || syslog.msg.nonconformant'
assert not run('-Y', malformed_filter, '-T', 'fields', '-e', 'frame.number').strip()
arguments = ['-Y', 'syslog', '-T', 'fields']
for name in fields:
    arguments += ['-e', name]
rows = run(*arguments).splitlines()
assert len(rows) == len(messages)
for row in rows:
    values = row.split('\t')
    assert len(values) == len(fields)
    number, facility, severity = values[:3]
    m = manifest['frames'][int(number) - 1]['message']
    assert int(facility) == m['facility'] and int(severity) == m['severity']
    expected_fields = {'syslog.version': '1', 'syslog.hostname': m['hostname'], 'syslog.appname': m['appName']}
    for name, value in zip(extended, values[3:]):
        assert value == expected_fields[name]
version = subprocess.run([tshark, '--version'], capture_output=True, text=True, check=True, encoding='utf-8').stdout.splitlines()[0]
report = {'generatedAt': datetime.now(timezone.utc).isoformat(), 'passed': True, 'engineContract': manifest['engineContract'], 'engineSourceHash': manifest['engineSourceHash'], 'decoders': ['Scapy', 'TShark'], 'wiresharkVersion': version, 'wiresharkFields': fields, 'strictHeaderAndUtf8Validated': True, 'packets': len(packets), 'syslogPackets': len(messages), 'malformed': 0, 'checksums': dict(checks), 'collectorEntries': len(manifest['entries'])}
(root / 'independent-captures.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report))
