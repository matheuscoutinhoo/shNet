# ADR-002 — Agregado JSONB em PostgreSQL

Status: aceito.
Guardar topologia como agregado atômico validado e versionado. Usuários/sessões/projetos/snapshots são entidades relacionais. Evita updates parciais entre interfaces/conexões. Indexar partes JSONB ou extrair projeções se analytics exigirem. Saves com revisão otimista impedem sobrescrita silenciosa entre abas.
