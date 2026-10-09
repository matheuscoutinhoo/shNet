# ADR-008 - IPv4 policies and isolated lab assessment

Status: accepted.

Ordered ACLs and NAT belong to the network model, not the canvas. ACLs run at interface ingress/egress. NAT source and reverse-destination translations use the existing IPv4, ARP and Ethernet pipeline. ICMP trace identity is distinct from its translated identifier so the inspector can show the actual round trip.

Initially static, dynamic and PAT covered ICMP/UDP only. ADR-009 adds TCP and stateful TCP transit inspection. Hairpin and ICMP-error payload translation remain outside the model. Dynamic bindings have virtual expiry actions and are validated with the snapshot. Configuration changes clear these bindings.

Guided lab definitions are versioned code. The server grades the owner's saved snapshot on a bounded isolated engine with fresh traffic, not user-submitted completion flags or historical ping events. The latest result is attached to the saved revision, with completion history persisted separately from current validity.

Account session IDs are non-secret UUIDs independent of bearer-token hashes. Account deletion requires the current password and cascades through owned data. Migrations are discovered and applied transactionally in numeric order, retaining the existing schema_migrations history.

Visual groups and annotations remain outside protocol state. Device positions are not link lengths. The full original product scope remains tracked explicitly in requirements-coverage.md rather than declaring unimplemented advanced protocols complete.
