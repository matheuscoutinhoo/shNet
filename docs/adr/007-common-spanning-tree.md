# ADR-007 - Common spanning tree and bridge-local state

Status: accepted.

Implement one common spanning tree over the simulated point-to-point links. BPDUs are typed link-local frames processed before ordinary VLAN forwarding. Every bridge elects its root and port roles using received priority vectors; the UI does not calculate a global tree.

Discarding and learning states constrain the data plane. Classical STP uses two fixed forward-delay transitions. RSTP uses a bounded, simplified proposal/agreement exchange and alternate-port promotion on full-duplex links, with timed fallback for legacy/half-duplex neighbors. Edge configuration is explicit and incoming BPDUs suspend operational edge behavior.

Hello, information expiration and state transitions are serializable actions. Mode/configuration changes replace local instance tokens. Topology changes clear learned MACs; an internal change identifier limits repeated propagation. This identifier is simulation metadata, not an IEEE BPDU field.

State is optional in Snapshot v1, retaining old laboratories without automatically enabling STP. API validation rejects inconsistent roles, missing timers and blocked ports marked forwarding. Configuration restarts only the local bridge; other bridges learn changes through BPDUs.

This slice is not an IEEE conformance claim. PVST/MSTP, shared-media backup roles, configurable port priorities, guards and the complete standardized state machines remain out of scope. Loop/event budgets remain as independent safety limits.
