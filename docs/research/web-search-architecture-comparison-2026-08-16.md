# Picode Web Search Architecture Comparison

Date: 2026-08-16

## Verdict

Picode's web capability is architecturally competitive for a lightweight,
provider-neutral development harness, but it is not yet proven equivalent to
the first-party search experience of commercial agents.

The distinction is important:

- `pi-web-access` is a search federation and content-processing layer. Search
  quality ultimately comes from Exa, OpenAI, xAI, Brave, Tavily, Gemini,
  SearXNG, or another selected provider.
- Commercial agents normally own the model-to-search integration, citation
  rendering, usage telemetry, quotas, and hosted operational path as one
  product.

Picode therefore does not need to build a proprietary search index. It needs
to own a stable **Web Evidence Contract** above `pi-web-access` and prove the
quality of configured providers with black-box evaluations.

## Current Picode implementation

The checked tree pins `pi-web-access` 0.18.0 and loads it as Picode's default
web extension. Its public surface includes `web_search`, `source_check`,
`fetch_content`, and `get_search_content`.

The installed extension provides:

- zero-configuration Exa search;
- first-party OpenAI and xAI hosted-search routes when credentials permit;
- many interchangeable API providers and self-hosted SearXNG;
- domain and recency filters, multi-query and multi-provider search;
- page, PDF, GitHub repository, image, YouTube, and video handling;
- claim-check artifacts with exact passages, content hashes, and explicit
  supported/contradicted/unclear/missing-evidence outcomes.

Sources: [pi-web-access repository](https://github.com/nicobailon/pi-web-access),
local `package.json`, `src/extension/suite.ts`, `src/extension/pi-entry.ts`, and
`src/engine/readiness.ts`.

## Comparison with commercial search

| Dimension | Picode + pi-web-access | Commercial first-party search | Judgment |
|---|---|---|---|
| Provider choice | Many hosted providers plus self-hosted SearXNG | Usually one vendor-controlled route | Picode stronger |
| Retrieval source | Depends on selected provider; can call OpenAI/xAI/Gemini hosted search directly | Vendor-native index and ranking path | Potentially equal, configuration-dependent |
| Content breadth | Pages, PDFs, repositories, images, YouTube, local video | Commonly web pages and PDFs; varies by product | Picode strong |
| Citation machinery | Search citations plus optional `source_check` evidence artifacts | Inline citations are part of the native response contract | Capability is strong; product enforcement is weaker |
| Model integration | Client-side tools selected by Pi; provider results are normalized by the extension | Model plans, searches, filters, and cites inside one hosted inference | Commercial products stronger |
| Token control | Bounded stored-content retrieval and Picode Context Governor can cooperate | Anthropic dynamically filters search/fetch before context; OpenAI exposes search context controls | Picode has the pieces, but needs one enforced policy |
| Reliability and telemetry | Fallback chain and typed failures, but behavior depends on several third parties | Unified billing, rate limits, request lifecycle, and operational ownership | Commercial products stronger |
| Privacy and control | Can keep queries on self-hosted SearXNG and choose providers | Usually vendor-hosted | Picode stronger when explicitly configured |
| Lock-in | Low | High | Picode stronger |

Cursor's official documentation says its `@Web` uses Exa and supports direct PDF
links. This means Picode's zero-config Exa route is not intrinsically a lower
class of retrieval source; the remaining difference is integration and product
quality, not simply the search backend.

OpenAI exposes web search as a model-selected Responses API tool, with sourced
citations and distinct quick, agentic, and deep-research paths. Anthropic's
server-side web search supports citations, domain controls, usage limits, and
dynamic filtering before results enter the context. Gemini's Google Search
grounding returns search steps and inline citation annotations. xAI similarly
provides hosted web search, page browsing, domain filters, image search, and
citations.

Primary references:

- [OpenAI Web search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [Anthropic Web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- [Anthropic Web fetch tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)
- [xAI Web Search](https://docs.x.ai/developers/tools/web-search)
- [Gemini Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)
- [Cursor @Web](https://docs.cursor.com/en/context/%40-symbols/%40-web)

## Gaps that prevent an equivalence claim

1. Picode has not run a provider-neutral retrieval evaluation, so relevance,
   freshness, citation correctness, latency, and failure recovery are not
   measured against commercial agents.
2. `source_check` is available but is not yet a mandatory completion contract
   for research claims. A model may stop after `web_search` and emit weaker
   citations.
3. Readiness currently treats the zero-config Exa fallback as `Ready`. That is
   convenient, but it is not the same as an authenticated provider with known
   quota and operational guarantees.
4. Provider fallback can change the privacy, cost, ranking, and citation
   semantics of a request. Picode needs to expose the provider actually used and
   degraded/fallback state rather than presenting all successful searches as
   equivalent.
5. Hosted commercial tools can filter results before they consume model
   context. Picode must ensure large search/fetch artifacts flow through its
   retention and Context Governor policy without losing fresh evidence.

## Recommended design

Keep `pi-web-access`; do not build a proprietary search engine. Add a thin
Picode-owned **Web Evidence Contract**:

```text
model intent
  -> web_search (provider route is explicit and observable)
  -> optional fetch_content
  -> source_check for completion-critical factual claims
  -> evidence refs + provider + query + URL + fetchedAt + content digest
  -> bounded injection through Context Governor
```

Required behavior:

- expose the actual provider, fallbacks, latency, cost/usage when available,
  and failure class;
- never silently claim authenticated readiness when only a best-effort fallback
  is available;
- preserve exact source IDs and content digests across Slice/Capsule handoff;
- require claim-level evidence for research deliverables, while ordinary coding
  lookups remain lightweight;
- let native OpenAI/xAI/Gemini routes satisfy the same contract rather than
  adding separate model-specific user workflows;
- evaluate 30-50 development queries across freshness, relevance, fetch success,
  citation support, latency, token use, and cost before claiming parity.

## Final assessment

Picode is already competitive in **coverage, replaceability, auditability, and
content extraction**. It is behind commercial agents in **first-party
integration, predictable default quality, unified telemetry, and enforced
claim-to-citation closure**. The architecture is suitable; the missing work is
product-level evidence governance and measurement, not a new search engine.
