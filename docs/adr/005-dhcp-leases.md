# ADR-005 - DHCP leases and virtual timers

Status: accepted.

Client state belongs to each routed interface; server pools and bindings belong to the serving device. DHCP runs over the shared UDP/IPv4/Ethernet pipeline, never through a host socket or a UI-only shortcut. Client, server, configuration validation and message transmission are separate modules.

T1, T2, retries, offer expiry and lease expiry are serializable queue actions. Transaction and lease identifiers prevent delayed messages and obsolete timers from mutating a newer exchange. The client measures its lease from the request and removes expired addressing before retrying discovery. Pool exhaustion is observable and retries are bounded.

Recurring renewal means the queue need not become empty. `advanceTo(timestamp, maxSteps)` supplies a bounded virtual horizon while `step()` retains single-event educational control. Wall-clock timers remain only in the UI playback adapter.

The existing JSONB checkpoint stores pools, bindings, interface options and timers atomically. DHCP fields are optional additions to schemaVersion 1, so current readers can load older snapshots without a SQL migration. Older readers cannot understand the new UDP packets or DHCP actions. The API rejects mismatched addressing, invalid pools and missing active lease timers.

Alternatives rejected: assigning addresses directly from a React form; scheduling protocol timers with real `setTimeout`; storing every DHCP event as a database row; copying a live lease when duplicating a device. These would respectively bypass forwarding, break deterministic pause/restore, add unnecessary persistence traffic, or duplicate an address and identity.

Historical scope at acceptance: local DHCPv4 only. Relay and reservations were subsequently added by [ADR-014](014-dhcp-relay-and-arp-retry.md); DNS resolution was added by ADR-006/011. DHCPv6, conflict detection/DECLINE and DHCP snooping still require later protocol work and tests.
