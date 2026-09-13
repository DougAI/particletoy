# Optional AI provider adapter

particletoy is a static application. It never accepts, stores, or publishes model API
keys. Clipboard mode works without a provider. Automated generation is available only
through a server-side adapter chosen by the user.

## Version 1 contract

The editor sends an HTTPS `POST` with `Content-Type: application/json`:

```json
{"version":1,"request":"complete particletoy edit request"}
```

The adapter returns either a particletoy patch directly or wrapped in `patch`:

```json
{"patch":{"version":1,"summary":"Brighter sparks","operations":[{"op":"replace","path":"/scene/bloom","value":1.1}]}}
```

Responses over 512 KB, non-JSON responses, and invalid patch envelopes are rejected.
Cross-origin endpoints must use HTTPS. The browser sends no credentials cross-origin;
same-origin adapters may use secure, HTTP-only cookies. CORS, authentication, rate
limits, model credentials, and abuse controls belong on the adapter. Do not put a model
token in the URL, client JavaScript, effect JSON, or published metadata.

The returned operation document still passes through particletoy's preview, schema,
path, reference, and size validation. The user must explicitly apply it, and the change
remains undoable.
