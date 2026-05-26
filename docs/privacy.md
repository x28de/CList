# CList Privacy Model

CList is a client-side application: it stores credentials encrypted in kvstore and fetches
content directly from third-party services in the browser. There is no CList proxy that could
shield your activity from those services. This document describes what each service learns about
you, what is currently done to limit exposure, and what is planned.

---

## What third-party services learn

### Annotation servers (annotations.mooc.ca, Hypothes.is)

Every time CList checks for annotations on a feed item it sends that item's URL to each
configured annotation server. The server therefore learns:

- Which URLs you are reading (via the `uri` query parameter in annotation search requests)
- Approximately when you read them (request timestamp)
- Your IP address

This happens automatically for every item that loads into the feed, not just items you click on.

**Planned mitigation:** a user-configurable annotation privacy level (see below).

### DID document hosts

When CList resolves a followed user's DID (e.g. `did:web:kvstore.mooc.ca:users:downes`), it
fetches `https://kvstore.mooc.ca/users/downes/did.json`. The host of that DID document therefore
learns your IP address and that you are interested in that user. This happens at login and when
annotation services are active.

### Feed sources (RSS, OPML)

Standard RSS fetch behaviour: each feed host sees your IP and user-agent when the feed is
polled. This is no different from using any RSS reader.

### Social platforms (Mastodon, Bluesky, etc.)

API calls to social platforms are made directly from your browser using your stored credentials.
Each platform sees your IP and the full scope of your API activity.

---

## What CList does not expose

- **Passwords and API keys** are derived or stored client-side and encrypted with a key that
  never leaves your browser. kvstore holds only ciphertext.
- **Reading history** is not sent to any CList server; the kvstore only stores account
  credentials, social graph data, and user preferences.
- **Cross-service correlation** — CList does not aggregate or transmit data between services
  on your behalf.

---

## Planned: annotation privacy levels

The most actionable privacy improvement is giving users control over when annotation servers
are queried. The proposed levels are:

| Level | Behaviour |
|-------|-----------|
| **Open** | Query all configured annotation services for every item (current behaviour) |
| **Selective** | Exclude specific annotation servers from automatic queries |
| **On-demand** | Never query automatically; only fetch annotations when the user explicitly requests them for a specific item |
| **Off** | Disable all annotation services entirely |

This is a non-trivial feature (it affects `checkAnnotationsBatch`, `showAnnotations`, and the
badge rendering pipeline) and is deferred. It is documented here so that the privacy tradeoff
is explicit and the solution space is understood before implementation begins.

---

## Known limitations

### DID federation spoofing

When CList discovers a followed user's Hypothes.is account from their DID document, it trusts
that claim. A malicious actor you follow could in principle claim another person's Hypothes.is
username in their DID document, causing that person's annotations to appear attributed to the
wrong identity in your feed.

**Current mitigation:** when a user adds their own Hypothes.is account to CList, the API key is
verified against the Hypothes.is `/api/profile` endpoint, and the returned username must match
the one entered. This ensures configured accounts are genuine.

**Remaining gap:** accounts discovered via DID federation (followed users) are not verified this
way, because CList does not hold their API keys. A proof-annotation mechanism — requiring the
Hypothes.is user to have annotated their own DID document URL — would close this gap but
requires user setup. This is noted as a future hardening step.

### DID document integrity

DID documents not created through CList's identity panel cannot be verified for internal
consistency. CList trusts the content of any DID document it fetches at face value.
