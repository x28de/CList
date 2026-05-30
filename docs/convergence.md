# Convergence

CList is built around the fact that, on the open web, a single act of writing can simultaneously be many things — a reply in a social thread, a notification to a source, an annotation on a document, a post in your own feed. Most tools force you to choose one. CList does all of them at once.

This document describes the convergence features: the ways a single CList post reaches out to multiple services and network layers in one publishing action.

---

## The model

When you load items into the editor, CList builds a **reference list** — one entry per source. Each reference records where the content came from: the URL, the author, the service type, and any service-specific reply metadata. When you publish, CList works through the reference list and creates the appropriate network relationships for each service that supports them.

The reference list is the connective tissue. It persists across the editing session and is the source of truth for all convergence actions at publish time.

---

## Thread replies

When the source of a loaded item is a social platform that supports native threading, CList publishes your post as a reply rather than a new top-level post.

**Mastodon** — if a reference came from a Mastodon post, publishing to a Mastodon account creates a threaded reply to that post. The thread appears in both your timeline and the original author's thread.

**Bluesky** — same behaviour for Bluesky sources. The reply is linked to the original post via Bluesky's `{uri, cid}` reply reference.

**Future** — as ActivityPub cross-service threading matures (Mastodon replying to Pixelfed, Misskey, etc.), CList will extend this to any ActivityPub source, not just same-platform posts.

Reply threading is automatic when a reference carries a matching service token. No separate action is required.

---

## WebMention

WebMention (W3C Recommendation) is a standard notification protocol: when you publish something that references another URL, you notify that URL's server that you've written about it. The receiving server can display your post as a response, trackback, or incoming link.

In CList, WebMention fires after a successful publish for every reference that has a URL — regardless of the service type. A post that references a WordPress article, a personal blog, a news page, or any URL-bearing source will send a WebMention to that source.

**WebMention is opt-in.** It is disabled by default and must be enabled in CList Options. When enabled, it fires silently after publish; failures are logged but do not block the post.

WebMention is implemented in `js/webmention.js`.

---

## Annotations

CList supports the W3C Web Annotation model. Annotations are stored on a server you control (default: `annotations.mooc.ca`, configurable to any compatible server) and are identified by your DID rather than a third-party platform account.

When you publish a post, annotations are created for each reference in the list — linking your post to the source URL with the `replying` motivation. These annotations are readable by anyone following you and appear alongside the source content when other CList users view it.

Annotations are a distinct layer from thread replies: a Mastodon reply goes into Mastodon's thread; the annotation goes into the open web annotation layer. Both can exist simultaneously for the same act of writing.

---

## Collections as synthesis

When you load multiple items into the editor (via collections or by loading items one by one), the reference list accumulates all sources. The published post is a synthesis — a response to all of them at once. Each convergence action (thread reply, WebMention, annotation) fires for each reference independently.

This is the core of what makes CList a learning tool rather than a communication tool: the cycle of reading from many sources, synthesising, and publishing back — with attribution preserved and network relationships created — in a single act.

---

## Identity

All convergence actions carry your DID (`did:web:kvstore.mooc.ca:users:{username}`) as the author identity. This means your replies, annotations, and WebMentions are all verifiably linked to the same identity, regardless of which service receives them.

See `identity-did.md` for the full DID infrastructure.

---

## What is not convergence

Posting to multiple social accounts simultaneously (Mastodon + Bluesky + WordPress) is **multi-publishing**, not convergence. Multi-publishing is handled by the publisher registry and `postAll()`. Convergence is specifically about the network relationships created *because of* a reference — replies, notifications, annotations — that arise from the source material, not from the destination accounts.
