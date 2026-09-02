---
name: web-research
description: Keyless multi-engine web search (DuckDuckGo + Bing) and Markdown content scraper (Hermes Agent style).
---

# Web Research & Scraping Skill (Hermes Agent Doctrine)

Autonomous web exploration and extraction capability for the agent without requiring external API keys.

## Features

1. **Multi-Engine Search**:
   - Primary: DuckDuckGo HTML & Lite
   - Secondary: Bing Search
   - Smart URL tracking parameter removal (`utm_*`, `fbclid`, `ref`)

2. **Clean HTML-to-Markdown Extraction**:
   - Converts HTML structure directly to Markdown (`# Headings`, ````Code Blocks````, `[Links](url)`, `- Lists`).
   - Strips boilerplate navigation, footers, scripts, styles, and cookie banners.
   - Extracts page reference links for follow-up reading.

## Model Tool Protocol

- **`web_search`**:
  ```json
  TOOL_CALL: {"name":"web_search","args":{"query":"python asyncio create_task best practices"}}
  ```

- **`web_scrape` / `web_extract`**:
  ```json
  TOOL_CALL: {"name":"web_extract","args":{"url":"https://docs.python.org/3/library/asyncio-task.html","maxChars":15000}}
  ```
