# Enterprise remediation — 27 October 2026

Implementation and retest of the [six-site audit](global-enterprise-validation-2026-10-26.md). The original enterprise failures are corrected, with additional native routing, campus, monitoring and QoS behavior. **This does not close every requirement for a complete Cisco enterprise simulator.** The selected advanced native inventory currently passes **44/61 checks**, with **17 explicit gaps**; this is not a percentage of Cisco functionality. Existing unrelated database/quorum work and historical evidence are preserved.

## Delivered behavior

| Audit item | Implementation and evidence |
| --- | --- |
| GE-01/02 | `no switchport` preserves Rapid PVST/MST. SVI DHCP relay supports multilayer switches, active HSRP gating and startup replay. The original topology converges without the workaround; focused and six-site fresh-lease failover tests pass. |
| GE-03/04/05 | Correct VRF/address-family context; per-device boot/reload uptime; OSPF ECMP, `maximum-paths`, stable flow hashing and failed-path withdrawal. |
| GE-06 | OSPFv2 binary encoding/decoding for all five packet types and supported LSAs, Fletcher/packet checksums, native MD5 header/trailer; HSRPv1/v2 and single-hop BFD codecs. Actual exchanges and independent Node crypto calculations supplement codec tests. External Cisco interoperability is not certified. |
| GE-08 | Native passive defaults/exceptions, reference bandwidth, stub/NSSA, ABR ranges, conditional default origination and MD5. BGP prefix-lists/route-maps, peer-group inheritance/member overrides, maximum-prefix shutdown and TCP MD5. BFD withdraws OSPF adjacencies within 200 ms in the loss test and recovers through actual packets. |
| GE-09 (partial) | ACL/interface PAT overload supports configuration before addressing, translates real return traffic, and removes obsolete bindings/timers when the outside address changes. Other WAN gaps remain below. |
| GE-10 | DHCP snooping, DAI, source guard, static bindings, port-security/sticky learning, root/loop guard, UDLD aggressive detection/err-disable/reset, and 802.1X global/controlled-port behavior. |
| GE-11 (partial) | MQC classification, marking, policers, LLQ/WRR, output shaping and validated allocations. Remaining-bandwidth percentages are distinct from absolute percentages. Voice VLAN switchport classification/tagging is modeled. |
| GE-12 | Native NTP with 64-second default polling, timezone, bounded virtual config archives, real ICMP IP SLA, interface/SLA tracking, tracked route withdrawal/recovery and HSRP priority changes. Inventory/environment/errors/forwarding displays read model state. |
| GE-13 (partial) | MST region configuration, numbered ACLs and TCP `established` ACK/RST matching. HSRP authentication remains open. |
| Integration | Startup replay where supported; cloned IP/MAC/VLAN/port identities and fresh protocol timers; physical security does not leak into logical interfaces; runtime excluded from configuration diffs; routing/switching capability checks. The app fidelity matrix states the remaining limits. |

## Validation

Engine contract: `2026.10.27.1`. Build, typecheck, lint and `git diff --check` pass. The enterprise manifest verifies unchanged engine source throughout regeneration and testing. Browser validation uses built assets and a disposable in-memory database without accessing the user's PostgreSQL directory.

| Final check | Result |
| --- | --- |
| Full regression suite | **1,072 passed, 0 failed, 2 skipped**, across 114 files. The existing skips are universal integrated-PCAP coverage and server-PostgreSQL backup/restore integration. Neither is claimed as validated. |
| Enterprise topology | **17/17 cases passed**, 72 devices, 101 links, six sites. No STP workaround. |
| Device persistence | **38/38 startup saves and 38/38 reloads**, followed by all 30 corporate paths recovering. |
| Browser | **1/1 Playwright test passed**. All 12 scenario flows pass; server replay is `matched`; import, native CLI, save/reopen/export pass. Zero browser errors and project API failures. Screenshots visually inspected. |
| Static preflight | Browser preflight reports **0 errors and 49 warnings**. The fixture retains single-homed endpoints and shared-service dependencies, including one central DHCP server. Passing gateway/WAN failover does not establish full service redundancy. |
| Native advanced inventory | **44/61 selected checks pass**, 17 gaps retained below. ECMP has two next hops; independent OSPF capture has zero exclusions. |
| Sample enterprise capture | 1,967 packets, zero codec exclusions and zero capture-retention drops in this run. This sample uses the configured capture filter; it is not a trace of every control protocol. |

The engine, built browser and server replay share source hash `2bed657fdbf2b43d0f246bb82f21093fc318425bd298fdb4274cd05e38d017db`. The isolated browser server was stopped after validation. Vite retains a non-failing warning about the size of the main engine chunk.

The expanded enterprise run has 17 cases: 30 corporate ICMP paths; 30 guest denials; six HTTP/DNS/DHCP clients; HSRP/OSPF state; fresh leases after simultaneous failure of all six primary cores; five independent infrastructure failures; total Sydney WAN isolation; snapshot restoration; 38 startup saves; and full routing/switching reload followed by restored corporate paths.

- [Regression results](../artifacts/enterprise-remediation-2026-10-27/unit-tests.json).
- [Enterprise behavior](../artifacts/enterprise-remediation-2026-10-27/behavior-results.json), [source manifest](../artifacts/enterprise-remediation-2026-10-27/validation-manifest.json), [native transcripts](../artifacts/enterprise-remediation-2026-10-27/native-workflows.json).
- [Startup saves](../artifacts/enterprise-remediation-2026-10-27/startup-save.json), [reloads](../artifacts/enterprise-remediation-2026-10-27/startup-reload.json), [DHCP failover](../artifacts/enterprise-remediation-2026-10-27/dhcp-failover.json).
- [Browser results](../artifacts/enterprise-remediation-2026-10-27/browser-results.json), [browser evidence](../artifacts/enterprise-remediation-2026-10-27/ui-evidence.json), [screenshots](../artifacts/enterprise-remediation-2026-10-27/screenshots/).
- [PCAP](../artifacts/enterprise-remediation-2026-10-27/sample-traffic.pcap), [export summary](../artifacts/enterprise-remediation-2026-10-27/capture-summary.json). Capture retention is bounded; dropped capture frames do not measure network packet loss.

The first development-wide test run overlapped source edits and produced stale-schema failures. It is retained as `unit-tests-during-development.json`, not final evidence. Focused reruns passed before the frozen run. Inventory prerequisite N53 now defines `WAN-QOS` before attaching it: rejection of an undefined policy was correct behavior. Historical audit evidence remains unchanged.

## Remaining requirements

| Probes | Open implementation |
| --- | --- |
| N01–N07, N10, N12 | Native VTY/SSHv2, local admin users, domain/key generation, AAA/RADIUS server submodes, SNMPv3 authPriv, NETCONF over SSH and native secure HTTP management. Educational AAA/remote-management APIs do not supply those native protocols. |
| N22–N24 | OSPFv3, EIGRP and IS-IS engines/processes. IPv6 addressing/static forwarding does not provide dynamic IPv6 routing. |
| N32–N35 | VRF-aware OSPF, native MPLS/LDP, IKEv2 proposals and Tunnel interfaces. Manual LFIB/FEC and educational encrypted tunnels do not establish Cisco L3VPN/DMVPN/SD-WAN/IPsec equivalence. |
| N55 | HSRP text/MD5 authentication and authentication TLVs. Unsupported trailers are rejected by the decoder. |

Limits of the implemented subsets:

- OSPF MD5 has one active interface key, without key-chain rollover. Legacy custom HMAC authentication and DD/ACK headers without wire metadata remain explicit PCAP exclusions. Other educational envelopes, including STP/LACP/EAPOL/MPLS, also lack complete wire codecs; universal PCAP coverage remains open.
- BFD covers asynchronous IPv4 single-hop control packets and OSPF integration; Echo, Demand, authentication, multihop and BGP integration are absent. UDLD has simplified scheduling and no PCAP codec.
- MQC uses bounded queues and discrete WRR weights, without exact Cisco ASIC bandwidth guarantees. Shaping/queue-limit apply to `class-default`; unsupported hierarchy is refused. Voice VLAN does not provide automatic CDP/LLDP-MED phone provisioning or a complete Cisco voice control plane.
- 802.1X controls the existing educational EAPOL/RADIUS model, without all enterprise EAP methods or complete native AAA configuration. Advanced configurations without startup replay are refused rather than silently discarded.
- CLI remains a subset with legacy educational extensions. IOS XE/IOS XR/NX-OS/ASA/controller images, image-specific defaults/defects, licenses and hardware limits are not emulated. Exact equivalence requires further implementation and comparison against authorized reference devices/images.

## Reproduce

```powershell
npm run build
npm run lint
npx vitest run --reporter=json --outputFile=artifacts/enterprise-remediation-2026-10-27/unit-tests.json
npx tsx artifacts/enterprise-remediation-2026-10-27/run-enterprise.ts
# Separate process: isolated app, then browser test
npx tsx artifacts/enterprise-remediation-2026-10-27/browser-server.ts
npx playwright test --config artifacts/enterprise-remediation-2026-10-27/playwright.config.ts
```

Protocol references: [OSPFv2/RFC 2328](https://www.rfc-editor.org/rfc/rfc2328.html), [TCP MD5/RFC 2385](https://www.rfc-editor.org/rfc/rfc2385.html), [HSRPv1/RFC 2281](https://www.rfc-editor.org/rfc/rfc2281.html), [UDLD/RFC 5171](https://www.rfc-editor.org/rfc/rfc5171.html), [BFD/RFC 5880](https://www.rfc-editor.org/rfc/rfc5880.html), [single-hop BFD/RFC 5881](https://www.rfc-editor.org/rfc/rfc5881.html).
