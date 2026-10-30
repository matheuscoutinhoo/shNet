from pathlib import Path

# Only the configuration-mode CLI examples identified by the regression report.
changes = {
 'bgp.test.ts': [('Established', 'show ip bgp summary'), ('prefix-filter in 10 permit 192.168.20.0/24', 'show running-config'), ('B 192.168.20.0/24 [20/0] via 10.0.12.2', 'show ip route')],
 'engine.test.ts': [('4096.', 'show spanning-tree'), ('hits=1','show access-lists'), ('192.168.20.100','show ip nat translations')],
 'device-terminal.test.ts': [('10','show vlan'), ('20','show vlan')],
 'dhcp-relay.test.ts': [('giaddr=192.168.10.1','show ip dhcp relay'), ('ip helper-address 192.168.20.10','show running-config')],
 'firewall.test.ts': [('firewall protocols udp icmp','show running-config')],
 'mpls.test.ts': [('200','show mpls forwarding-table')],
 'ospf.test.ts': [('[110/31] via 10.0.13.3','show ip route'), ('router','show ip ospf database'), ('router ospf 1.1.1.1','show running-config'), ('[110/20] via 10.0.12.2','show ip route')],
 'rip.test.ts': [('split horizon','show ip rip interface'), ('no ip rip poison-reverse','show running-config'), ('[120/2]','show ip route')],
 'sdwan.test.ts': [('Tunnel1','show tunnels'), ('[configured]','show running-config')],
 'vrrp.test.ts': [('no vrrp 10 preempt','show running-config'), ('00:00:5e:00:01:0a','show vrrp')],
}
for file, pairs in changes.items():
    path = Path('tests') / file
    content = path.read_text(encoding='utf-8')
    for expected, command in pairs:
        old = f"expect(cli.execute('{command}')).toContain('{expected}')"
        new = old.replace(f"execute('{command}')", f"execute('do {command}')")
        assert old in content, (file, old)
        content = content.replace(old, new, 1)
    if file == 'ospf.test.ts':
        content = content.replace(".toContain('router ospf 1.1.1.1')", ".toContain('router-id 1.1.1.1')")
    if file == 'sdwan.test.ts':
        content = content.replace("expect(cli.execute('show running-config')).not.toContain(c.key)", "expect(cli.execute('do show running-config')).not.toContain(c.key)")
    if file == 'device-terminal.test.ts':
        content = content.replace("expect(cli.execute('show spanning-tree')).toContain('não se aplica')", "expect(cli.execute('do show spanning-tree')).toContain('não se aplica')")
        content = content.replace("expect(cli.execute('show ip ospf')).toContain('não se aplica')", "expect(cli.execute('do show ip ospf')).toContain('não se aplica')")
        content = content.replace("expect(cli.execute('show spanning-tree')).not.toMatch(/não se aplica|não reconhecido/)", "expect(cli.execute('do show spanning-tree')).not.toMatch(/não se aplica|não reconhecido/)")
    path.write_text(content, encoding='utf-8', newline='\n')
