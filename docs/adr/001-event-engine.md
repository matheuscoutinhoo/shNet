# ADR-001 — Eventos discretos

Status: aceito.
Motor puro e serializável, eventos ordenados por tempo virtual e sequência. Alternativa rejeitada: lógica dentro de nós React e setTimeout para protocolos. Benefícios: determinismo, testes e replay. Custo: cada protocolo exige ações/estado explícitos.
