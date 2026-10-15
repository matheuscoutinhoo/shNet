"""Decode actual simulated TCP captures with Scapy and TShark, not TS codecs."""
import csv
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
from scapy.all import Ether, IP, TCP, UDP, rdpcap

root = Path('.data/captures')
tshark = os.environ.get('TSHARK_PATH') or shutil.which('tshark')
if not tshark and os.name == 'nt':
    candidate = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Wireshark/tshark.exe'
    if candidate.is_file():
        tshark = str(candidate)
if not tshark:
    raise RuntimeError('TShark is required; install it or set TSHARK_PATH.')


def run(*args):
    return subprocess.run([tshark, *args], check=True, capture_output=True, text=True, encoding='utf-8').stdout


fields = ['frame.number', 'bgp.type', 'bgp.cap.4as', 'bgp.cap.mp.afi', 'bgp.cap.mp.safi',
          'bgp.update.path_attribute.as_path_segment.as4', 'bgp.withdrawn_prefix',
          'bgp.evpn.nlri.rt', 'bgp.evpn.nlri.etag', 'bgp.evpn.nlri.vni',
          'bgp.evpn.nlri.mac_addr', 'bgp.evpn.nlri.ip.addr', 'bgp.ext_com_evpn.mmac.seq',
          'bgp.update.path_attribute.mp_unreach_nlri.afi', 'bgp.update.path_attribute.pmsi.tunnel.type']
summary = {'decoder': run('--version').splitlines()[0], 'captures': []}
for name in ['bgp', 'evpn']:
    file = root / f'{name}-binary.pcap'
    metadata = json.loads(file.with_suffix('.json').read_text(encoding='utf-8'))
    packets = rdpcap(str(file))
    assert len(packets) == metadata['packets'] and not metadata['excluded'] and metadata['dropped'] == 0
    checksums = 0
    for packet in packets:
        for layer in (IP, TCP, UDP):
            index = 1
            while packet.getlayer(layer, index) is not None:
                original = packet.getlayer(layer, index).chksum
                copied = packet.copy()
                del copied.getlayer(layer, index).chksum
                assert Ether(bytes(copied)).getlayer(layer, index).chksum == original, (name, layer, index)
                checksums += 1
                index += 1
    malformed = run('-r', str(file), '-Y', '_ws.malformed', '-T', 'fields', '-e', 'frame.number')
    assert not malformed.strip(), (name, malformed)
    args = ['-r', str(file), '-Y', 'bgp', '-T', 'fields', '-E', 'separator=/t', '-E', 'occurrence=a']
    for field in fields:
        args += ['-e', field]
    rows = [dict(zip(fields, row)) for row in csv.reader(io.StringIO(run(*args)), delimiter='\t')]

    def values(field):
        return {v for row in rows for v in row[field].split(',') if v}

    assert {'1', '2', '4'} <= values('bgp.type'), name
    if name == 'bgp':
        assert {'4200000001', '4200000002', '4200000003'} <= values('bgp.cap.4as')
        assert '4200000003' in values('bgp.update.path_attribute.as_path_segment.as4')
        assert '192.168.20.0' in values('bgp.withdrawn_prefix')
    else:
        assert {'25'} <= values('bgp.cap.mp.afi') and {'70'} <= values('bgp.cap.mp.safi')
        assert {'2', '3'} <= values('bgp.evpn.nlri.rt')
        assert values('bgp.evpn.nlri.etag') == {'10010'}
        assert values('bgp.evpn.nlri.vni') == {'10010'}
        assert '10.50.0.10' in values('bgp.evpn.nlri.ip.addr')
        assert '1' in values('bgp.ext_com_evpn.mmac.seq')
        assert '25' in values('bgp.update.path_attribute.mp_unreach_nlri.afi')
        assert '6' in values('bgp.update.path_attribute.pmsi.tunnel.type')
    summary['captures'].append({'name': name, 'packets': len(packets), 'checksums': checksums,
                                'malformed': 0, 'excluded': 0, 'dropped': 0, 'bgpRecords': rows})

out = Path(os.environ.get('SHLAB_AUDIT_OUTPUT', 'artifacts/bgp-evpn-codecs-2026-10-15'))
out.mkdir(parents=True, exist_ok=True)
(out / 'independent-captures.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'decoder': summary['decoder'], 'captures': [{k: v for k, v in c.items() if k != 'bgpRecords'} for c in summary['captures']]}))
