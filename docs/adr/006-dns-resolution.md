# ADR-006 - DNS over simulated UDP

Status: accepted.

DNS is a discriminated UDP payload, with separate record validation, client, server and message modules. Queries use the existing IPv4, route, ARP, link and Ethernet behavior. No OS resolver, external DNS API or real network socket is used.

The authoritative laboratory server supports A, AAAA and CNAME. AAAA records contain IPv6 data but are transported over the existing IPv4 stack. Alias traversal is bounded and conflicting CNAME records are rejected. This does not introduce zones, recursive resolution, DNSSEC, EDNS or TCP fallback.

The client uses DNS servers configured on interfaces or delivered by DHCP. Each outstanding query has an ephemeral port, seeded transaction identifier, selected server, question and virtual timeout. Replies must match these fields. Two attempts per server and bounded history prevent unbounded event growth. Positive cache entries expire at the lowest TTL in the returned chain.

Packets model uncompressed DNS size. Responses exceeding 512 DNS bytes signal truncation and are not silently consumed as complete answers. Header fields, records, status and timing remain inspectable in the workspace and terminal.

Optional server records, query state, cache and timers are persisted in Snapshot v1. Existing snapshots remain readable without a database schema migration. API validation checks record conflicts, timer references, query answers and cache expiry. The earlier DNS limitation in ADR-005 is superseded by this slice.

Trade-offs: no binary packet codec, name compression, negative caching, full recursive hierarchy or DNSSEC authenticity. Response correlation models basic resolver checks, not cryptographic trust. The legacy topology-hostname ping convenience remains; domain names use DNS before ICMP is sent.
