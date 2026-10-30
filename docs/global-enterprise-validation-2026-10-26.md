# Global enterprise network validation — 26 October 2026

**Verdict: the app can model a useful enterprise IPv4 network, but it cannot reproduce the exact behavior or configuration of a complete Cisco enterprise network.** A normal configuration sequence produced a forwarding storm. A standard campus DHCP design could not be configured. Several essential enterprise workflows require proprietary simulator extensions or are absent.

This is an engineering acceptance exercise against the current working tree, including the earlier uncommitted Cisco implementation. It is not Cisco certification, a comparison against live Cisco hardware, or a completion percentage. No product code was fixed during this audit. The original failing topology and the topology with a configuration-order workaround are both retained.

## Design and evidence

The lab has **72 devices and 101 links**, spanning **New York, São Paulo, London, Frankfurt, Singapore and Sydney**. Each site has two WAN routers, two multilayer distribution switches, two access switches, corporate/guest/admin/DHCP endpoints and a local application server. Two abstract private-IP WAN providers connect the sites. New York also hosts shared DNS, DHCP, NTP and syslog servers.

Each site uses `10.<site>.0.0/16`, corporate VLAN 10, guest VLAN 20 and management VLAN 99. HSRPv2 provides `.1` gateways; core addresses are `.2` and `.3`. OSPF area 0 connects the WAN, with one campus area per site. Access switches have redundant trunks, Rapid PVST and edge BPDU Guard. Guest ingress ACLs deny the corporate `10.0.0.0/8` destinations. WAN handoff delays are illustrative; these are abstract routed services, not physical intercontinental Ethernet, MPLS or Catalyst SD-WAN emulation.

The target enterprise architecture additionally needs controlled Internet/DMZ access, encrypted or provider-separated WANs, VRF-aware routing, secure management, wireless identity, data-center fabrics, QoS, service redundancy and observable failure handling. The six-site design exercises the supported core and exposes blockers to those extensions. Existing data-center/protocol regression tests supplement this lab; they do not make all those systems part of the six-site topology.

Cisco's [campus design guide](https://www.cisco.com/c/en/us/td/docs/solutions/CVD/Campus/cisco-campus-lan-wlan-design-guide.html) describes hierarchical campus/WAN integration and availability. Its [Catalyst SD-WAN design guide](https://www.cisco.com/c/en/us/td/docs/solutions/CVD/SDWAN/cisco-sdwan-design-guide.html) covers additional control, management and transport concerns that the private-IP WAN in this exercise does not reproduce.

Evidence directory: [`artifacts/global-enterprise-validation-2026-10-26`](../artifacts/global-enterprise-validation-2026-10-26/).

| Artifact | Purpose |
| --- | --- |
| [Original topology](../artifacts/global-enterprise-validation-2026-10-26/global-enterprise.shlab.json) | Preserves the configuration-order failure; import only in a disposable lab. |
| [Topology with workaround](../artifacts/global-enterprise-validation-2026-10-26/global-enterprise-workaround.shlab.json) | Same design with Rapid PVST reapplied after routed uplinks. DHCP remains blocked. |
| [Converged topology](../artifacts/global-enterprise-validation-2026-10-26/global-enterprise-converged.shlab.json) | Starts at 65,000 ms, avoiding initial convergence when reproducing operational tests. |
| [Design inventory](../artifacts/global-enterprise-validation-2026-10-26/design.json) | Site, equipment and addressing inventory. |
| [Configuration transcript](../artifacts/global-enterprise-validation-2026-10-26/configuration-transcript.json) | Commands and responses used to configure network devices. |
| [Native enterprise workflows](../artifacts/global-enterprise-validation-2026-10-26/native-workflows.json) | Independent command probes, VRF-mode and spanning-tree checks, ECMP and OSPF capture evidence. |
| [Behavior results](../artifacts/global-enterprise-validation-2026-10-26/behavior-results.json) | Expected and actual results, including failures; engine contract/source hash. |
| [Consolidated verification](../artifacts/global-enterprise-validation-2026-10-26/verification.json) | Inventory, build matching, test counts, replay and management-service results. |
| [Prioritized findings CSV](../artifacts/global-enterprise-validation-2026-10-26/findings.csv) | Issue IDs, priorities, categories, evidence and proposed acceptance criteria. |
| [Storm diagnosis](../artifacts/global-enterprise-validation-2026-10-26/storm-diagnosis.json) | Spanning trees, repeated HSRP frames and queued events. |
| [Convergence profile](../artifacts/global-enterprise-validation-2026-10-26/convergence-profile.json) | Virtual-time progress and queue growth before the workaround. |
| [Operational probes](../artifacts/global-enterprise-validation-2026-10-26/operational-probes.json) | Uptime error and independent BGP alternate-path result. |
| [Screenshots](../artifacts/global-enterprise-validation-2026-10-26/screenshots/) | Rendered UI and CLI evidence. |

## Confirmed bugs and fidelity failures

Severity is relative to enterprise design validation: **P1** blocks a required design or materially changes forwarding/security behavior; **P2** affects operational fidelity, workflow or diagnosis. These findings are not all security vulnerabilities in the hosting application.

### GE-01 · P1 · `no switchport` removes the global Rapid PVST configuration

Minimal reproduction on a powered-on multilayer switch:

```text
enable
configure terminal
vlan 10
exit
spanning-tree mode rapid-pvst
interface Gi0/1
no switchport
```

Expected: only the selected physical interface becomes routed; the switch retains its per-VLAN spanning trees. Observed: `no switchport` returns `OK`, but `multiSpanningTree` disappears. The handler calls the classic `configureSpanningTree` routine, which deletes the per-VLAN configuration.

In the enterprise design, distribution switches consequently run a common tree while access switches retain Rapid PVST. The trunks prune VLAN 1. At about **31,000 ms**, HSRPv2 multicast circulates through forwarding paths. During a bounded profile, the queued-event count grows from **1,629 to 8,360** while virtual time advances only from about **31,002 to 31,008 ms**. The original unrestricted audit was stopped; it never reached its 65-second warmup target. This was not merely slow OSPF convergence.

Evidence: native workflow **N61**, original topology, storm diagnosis and convergence profile. The queued frame is UDP/1985 to `224.0.0.102`, VLAN 10, repeatedly flooded through the campus. After reapplying `spanning-tree mode rapid-pvst` and the intended priorities on every distribution switch, the same topology converges and its traffic tests pass.

Workaround: configure routed ports first, then reapply Rapid PVST and priorities. Required fix: preserve the existing per-VLAN/MST configuration when changing one port's switching mode, and add a mixed SVI/routed-uplink regression with redundant trunks.

### GE-02 · P1 · Multilayer-switch SVI DHCP relay is rejected

On each core's already addressed, operational corporate SVI:

```text
configure terminal
interface Vlan10
ip helper-address 10.1.99.67
```

Observed response: `% DHCP relay requer interface routed de roteador com IPv4 estático.` All **12 core switches** reject it. The model checks `device.type !== 'router'` in `protocols/dhcp-config.ts`, despite the switch having IP routing and a routed SVI. All **six centralized DHCP clients fail to become bound**. The other hosts use explicit static addresses so routing/security tests can continue.

Catalyst switches support DHCP relay using `ip helper-address` on VLAN interfaces; see Cisco's [Catalyst 9300 DHCP troubleshooting examples](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9300-switch/221717-troubleshoot-dhcp-on-catalyst-9000-switc.html) and [DHCP configuration guide](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-15/configuration_guide/ip/b_1715_ip_9300_cg/configuring_dhcp.html).

Evidence: [relay attempts](../artifacts/global-enterprise-validation-2026-10-26/relay-attempts.json), `DHCP-01`, and [UI reproduction](../artifacts/global-enterprise-validation-2026-10-26/screenshots/svi-relay-rejection.png). A router-based relay is an architectural workaround, not an equivalent implementation of the intended campus design. DHCP relay reception/transmission and snapshot validation also need review before expanding the accepted device types.

### GE-03 · P2 · Accepted VRF definition does not enter VRF mode

`vrf definition CORP` returns `OK` while leaving the CLI in global configuration mode. The native `config-vrf` workflow cannot be continued normally. This is a semantic CLI failure, not simply an unrecognized command. Cisco's [`vrf definition` workflow](https://www.cisco.com/c/en/us/td/docs/ios/12_2sr/12_2srb/feature/guide/sr_mpvrf.html) enters VRF configuration mode and supports address-family submodes.

Evidence: **N31**, with the resulting context check `false`. Static VRF functions elsewhere in the app do not establish complete native VRF/L3VPN behavior.

### GE-04 · P2 · Device uptime is the lab clock

Advance an empty lab to 60 seconds, create/power on a router, and run `show version`; then reload it and repeat. Both outputs report **60.000 simulated seconds** of uptime. A new boot/reload should begin a new device uptime interval. This can mislead boot, recovery and monitoring exercises.

Evidence: [operational probes](../artifacts/global-enterprise-validation-2026-10-26/operational-probes.json). The implementation formats `engine.state.clock` directly in `cli/commands.ts`.

### GE-05 · P1 · OSPF does not retain both equal-cost paths

An independent four-router diamond has two operational paths with equal configured OSPF costs to `10.100.0.0/24`. The originating LAN is operational. The app installs **one next hop**, `192.0.1.2`, rather than both equal-cost alternatives. The SPF implementation retains a single `Hop` and breaks ties lexicographically.

Cisco OSPF supports multiple equal-cost routes; see [parallel-path routing configuration](https://spg.xgslb-v3.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-9/configuration_guide/rtng/b_179_rtng_9300_cg/protocol_independent_features.html) and [CEF load balancing](https://spg.xgslb-v3.cisco.com/c/en/us/support/docs/ip/express-forwarding-cef/18285-loadbal-cef.html). This affects load distribution, capacity and expected failure behavior even when ping succeeds.

Evidence: `native-workflows.json` → `ecmp`. This is a confirmed fidelity gap; no throughput or hashing-equivalence claim is made.

### GE-06 · P2 · Control-plane PCAP coverage prevents full troubleshooting

With control-plane capture enabled in the independent OSPF diamond, **216 OSPF frames are excluded** from PCAP export. The serializer reports `Protocolo IP OSPF sem codec binário.` The six-site traffic export also excludes **1,488 HSRP frames** because HSRP UDP payloads have no binary export codec. The simulator event model can inspect them, but a network engineer cannot use the exported PCAP to inspect the full OSPF/HSRP exchanges in an external analyzer.

Evidence: `native-workflows.json` → `ospfCapture`, plus the `ethernet-codec.ts` unsupported-protocol branches. The exporter reports exclusions rather than fabricating packets; preserve that behavior while implementing codecs.

## Missing enterprise workflows

The additional inventory deliberately probes **advanced enterprise workflows**, not the earlier core 42-command inventory. Of **61 selected checks, 5 pass and 56 expose gaps**. These counts are not a general success rate, do not mean previously passing core commands regressed, and do not measure every Cisco feature. Every probe includes its setup and response in `native-workflows.json`.

| ID | Priority | Enterprise requirement and observed limitation |
| --- | --- | --- |
| GE-07 | P1 | **Secure management:** native VTY, local username/secret, domain/SSHv2, AAA/RADIUS submodes and SNMPv3 workflows fail. JSON-based AAA/remote management elsewhere is not SSH2 or a native IOS management plane. N01–N07, N10, N12. |
| GE-08 | P1 | **Routing control:** native passive-interface, reference bandwidth, stub/summarization/default-origination/authentication, BGP prefix-list/route-map/peer-group/maximum-prefix/password and BFD workflows fail. Some engine features exist through custom configuration; they cannot be assessed as native Cisco workflows. N16–N21, N25–N30. |
| GE-09 | P1 | **WAN and tenant segmentation:** native VRF-aware OSPF, MPLS interface enable, IKEv2 proposal, Tunnel interface and PAT-overload workflows fail. A private-IP OSPF WAN does not validate enterprise MPLS L3VPN, DMVPN, Catalyst SD-WAN or IPsec interoperability. N32–N36. |
| GE-10 | P1 | **Campus access security:** native DHCP snooping, DAI, port-security, IP source guard and dot1x system control fail. Native root/loop guard and UDLD also fail. Existing custom security models require separate behavioral verification. N40–N47. |
| GE-11 | P2 | **QoS and voice:** MQC class-map/policy-map/service-policy and voice VLAN commands fail. Generic queue/traffic models do not validate Cisco MQC classification, policing, shaping, hardware buffers or production voice behavior. N48, N51–N53. |
| GE-12 | P2 | **Operations:** native NTP server, timezone, archive, IP SLA/object tracking, inventory/environment/interface-error counters and CEF commands fail. Syslog host configuration, LACP member/Port-channel commands, HSRP interface tracking and EtherChannel display do pass. N08–N15, N37–N38, N54, N56–N60. |
| GE-13 | P2 | **Other native coverage:** MST region submode, numbered extended ACL syntax, TCP-established ACL qualifier and HSRP authentication fail. N39, N49–N50, N55. |
| GE-14 | P1 for exact equivalence | **Platform and dual-stack fidelity:** OSPFv3/EIGRP/IS-IS process workflows fail (N22–N24). The app executes a generic educational model, not IOS XE/IOS XR/NX-OS/ASA/Catalyst wireless images. Licensing, ASIC/TCAM limits, image-specific defaults and defects, hardware scheduling, full Cisco controller/fabric behavior and vendor interoperability are not established by this audit. |

## Behavioral results after the workaround

The 14 acceptance cases record **13 passes and one failure**. The one failure is DHCP acquisition across all six sites. The results deliberately retain that failure.

| Test | Observation |
| --- | --- |
| DATA-01 | All 30 ordered cross-site corporate ICMP paths succeed. |
| SEC-01 | All 30 cross-site guest-to-corporate ICMP paths are denied. |
| APP-01 / DNS-01 | All six sites retrieve the New York HTTP application and resolve corporate DNS. |
| DHCP-01 | All six DHCP clients fail to bind because SVI relay could not be configured. |
| CTRL-01 / CTRL-02 | Each site's corporate HSRP group has one active and one standby; every configured non-passive OSPF interface has a Full neighbor. |
| HA-01–HA-05 | All 30 paths recover after primary New York core failure, all six primary WAN handoffs failing, primary provider failure, London primary edge failure, and Sydney access-uplink failure. |
| NEG-01 | Losing both Sydney WAN edges blocks remote traffic while preserving local application reachability. |
| PERSIST-01 | Restoring the converged snapshot preserves all 30 cross-site paths. |

The corrected initial 65-second warmup processes **32,865 events in about 40 seconds of wall time** on this run. This is a local measurement, not a capacity guarantee. Recovery cases probe after explicit settling intervals (16 or 50 virtual seconds); they establish eventual reachability, not exact Cisco convergence, zero loss or preservation of existing TCP/firewall sessions. Separate BGP evidence establishes six sessions across three routers and successful forwarding after switching from `10.0.13.3` to `10.0.12.2`.

Two additional management-service checks pass across all six regions: administrators synchronize deliberately offset clocks to the central NTP server, and the central collector receives each administrator's syslog message. These use the public service configuration APIs, not native `ntp server` syntax. See [management-service evidence](../artifacts/global-enterprise-validation-2026-10-26/management-services.json).

The lab intentionally retains single-homed endpoints and single shared-service servers to expose their failure domains. It does not establish full service DR, guest isolation from every infrastructure address, WAN encryption, complete IPv6 operation, QoS under contention, stateful-session preservation or a wireless deployment at every site. Those remain required acceptance work for a complete enterprise solution; they must not be inferred from the passing IPv4 tests.

## App workflow and validation scope

The native browser-control service was unavailable. The rendered application was exercised with the repository's Playwright/Edge test runner, against built production web assets and a disposable in-memory API database. No production PostgreSQL data or real enterprise credentials were used. Device configuration was generated through `TerminalSession`; cabling, endpoint addresses and service setup used public engine functions underlying the app controls. This was not a claim that 72 devices were manually dragged and typed into the UI.

The final UI test passes: it imports all 72 devices/101 links, finds Sydney, runs the native terminal, reproduces the SVI-relay rejection, inspects preflight, executes 12 application/isolation flows, requests server replay, saves/reopens the project and exports the topology. All 12 scenario flows pass and server replay reports `matched`. No page errors or project API failures were observed. Client, server and audit share engine hash `a88f28765ef1cee6351eebaeb3917e17c2efdce413fbdc13be429f05d6222024`.

Two initial browser attempts had harness errors: expecting an early route in xterm's visible DOM after a long response, and waiting for a verification button inside a collapsed scenario report. The final run filters the route output and expands the saved report. Both attempts are retained as `browser-attempt1.json` and `browser-attempt2.json`; neither is counted as an application defect.

All **38 network devices accept `write memory`** with their current supported configuration, which includes the spanning-tree workaround. This validates the save/replay checks, not a simultaneous reboot or exact platform boot timing. The separate snapshot persistence and UI save/reopen/export checks pass.

The existing enterprise-network, enterprise-protocol and routing-fidelity regression matrices also pass: **76 passed, zero failed, one skipped**. They cover additional educational-model behavior including EVPN/VXLAN tenant separation, wireless/RADIUS, stateful firewall, LACP, MTU, VPN/SD-WAN and failure controls. The skipped universal-PCAP case remains a coverage limitation; it is not counted as a pass. See [the regression report](../artifacts/global-enterprise-validation-2026-10-26/enterprise-regression.json).

Static preflight reports zero errors for the configured six-site lab and explicitly says it does not prove availability or traffic isolation. Its absence of errors must not be treated as proof of a complete enterprise design. This audit requires traffic, protocol-state, negative-control and failure tests in addition to preflight.

## Reproduction and priorities

From the repository root, with the existing dependencies installed:

```powershell
node --import tsx artifacts/global-enterprise-validation-2026-10-26/native-workflows.ts
node --import tsx artifacts/global-enterprise-validation-2026-10-26/operational-probes.ts
node --import tsx artifacts/global-enterprise-validation-2026-10-26/profile-convergence.ts
node --import tsx artifacts/global-enterprise-validation-2026-10-26/diagnose-flood.ts
node --import tsx artifacts/global-enterprise-validation-2026-10-26/enterprise-behavior.ts
node --import tsx artifacts/global-enterprise-validation-2026-10-26/management-services.ts
```

`enterprise-audit.ts` regenerates the original design and exits after saving it by default. Its optional `--run-original` flag reproduces the original unrestricted attempt and can stall in the storm. Use the bounded convergence profiler for the failure reproduction. The tested workaround runner reads the saved original topology and records every corrective command.

For browser checks, start the isolated server with `node --import tsx artifacts/cisco-implementation-2026-10-26/browser-server.ts`, then run `npx playwright test --config artifacts/global-enterprise-validation-2026-10-26/playwright.config.ts`. It uses localhost ports 5194/3094 and a fresh in-memory database. Results reference the exact current engine source hash in `behavior-results.json`.

Recommended implementation order: fix GE-01; implement and test multilayer-switch DHCP relay; correct VRF-mode and device-uptime semantics; establish secure native management; then complete routing policy/ECMP, WAN segmentation/security, access security and protocol capture. Keep the Cisco family/release feature contract explicit and require independent negative/failover tests before extending any fidelity claim.
