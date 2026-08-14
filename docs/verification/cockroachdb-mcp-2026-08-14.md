# CockroachDB Managed MCP Verification

- Date: `2026-08-14`
- Cluster name: `prior-dev`
- OAuth permission: `read-only`
- MCP tools used: `list_clusters`, `get_table_schema`, `select_query`
- Database accessed: `defaultdb`
- Table accessed: `public.investigation_memory`

## Sanitized MCP Result

```text
row_count: 31
case_ids:
case-b-checkout
case-b-precedent-replay
case-cloudflare-waf-2019
case-google-secops-2026
case-google-secops-debug-1786535778822
gbp-rub-june-2023
investigation_id: 07ec56bf-aa46-4d9e-9798-13a6d6d24e85
snapshot_id: 6919dd52-9c4d-42f5-b66b-a55dcbb9c339
```

## Sanitized Direct-`pg` Result

```text
row_count: 31
case_ids:
case-b-checkout
case-b-precedent-replay
case-cloudflare-waf-2019
case-google-secops-2026
case-google-secops-debug-1786535778822
gbp-rub-june-2023
investigation_id: 07ec56bf-aa46-4d9e-9798-13a6d6d24e85
snapshot_id: 6919dd52-9c4d-42f5-b66b-a55dcbb9c339
```

- Comparison result: `MATCH`
- Mutations performed: `none`

This verification covered interactive read-only metadata and query access only.
Runtime application integration remains pending, and no claim is made here that
raw JSON-RPC traffic was captured.
