# Design tokens — copy into every artifact

Use these tokens **verbatim** in the `<style>` of every HTML artifact you produce. They give all artifacts a coherent editorial look (neutral palette, system typography, generous whitespace, thin borders, no heavy shadows).

```css
:root {
  --ivory:   #F5F6F7;
  --slate:   #171B20;
  --gray-700:#343A42;
  --gray-500:#5F6670;
  --gray-300:#C7CBD1;
  --gray-150:#E9EBEE;
  --paper:   #FFFFFF;

  --clay:    #8A5D74;
  --olive:   #3F544E;
  --oat:     #D9DEE5;

  --sans:    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --serif:   Georgia, 'Times New Roman', ui-serif, serif;
  --mono:    ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--ivory);
  color: var(--gray-700);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
  padding: 48px 32px 96px;
}

.page {
  max-width: 1100px;
  margin: 0 auto;
}

.eyebrow {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--gray-500);
  margin-bottom: 10px;
}

h1 {
  font-family: var(--sans);
  font-weight: 700;
  font-size: 32px;
  color: var(--slate);
  letter-spacing: -0.015em;
  margin-bottom: 14px;
}
h2 {
  font-family: var(--sans);
  font-weight: 700;
  font-size: 19px;
  color: var(--slate);
  letter-spacing: -0.005em;
  margin: 36px 0 12px;
}
h3 {
  font-family: var(--sans);
  font-weight: 600;
  font-size: 14px;
  color: var(--slate);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 24px 0 8px;
}

p { margin-bottom: 14px; }
strong { color: var(--slate); font-weight: 600; }

.tldr {
  border: 1.5px solid var(--gray-300);
  border-left: 3px solid var(--clay);
  border-radius: 10px;
  background: var(--paper);
  padding: 20px 24px;
  margin: 18px 0 28px;
}

.card {
  background: var(--paper);
  border: 1.5px solid var(--gray-300);
  border-radius: 10px;
  padding: 20px 24px;
  margin: 14px 0;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--gray-150);
  color: var(--gray-700);
  border: 1px solid var(--gray-300);
  border-radius: 999px;
  padding: 3px 10px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.02em;
}
.chip.accent { background: var(--oat); border-color: transparent; color: var(--slate); }

table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--gray-300); }
th { font-weight: 600; color: var(--gray-500); text-transform: uppercase; font-size: 11px; letter-spacing: 0.06em; }

pre, code { font-family: var(--mono); font-size: 13px; }
pre {
  background: var(--gray-150);
  border: 1px solid var(--gray-300);
  border-radius: 8px;
  padding: 14px 16px;
  overflow: auto;
  line-height: 1.5;
}
:not(pre) > code { background: var(--gray-150); padding: 1px 6px; border-radius: 4px; }

a {
  color: var(--clay);
  text-decoration: none;
  border-bottom: 1px dashed transparent;
  transition: border-color 120ms ease-out, color 120ms ease-out;
}
a:hover { border-bottom-color: var(--clay); }

a.file-link {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--gray-700);
  border-bottom: 1px dashed var(--gray-300);
  word-break: break-all;
}
a.file-link:hover { color: var(--clay); border-bottom-color: var(--clay); }

.page.with-nav {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: 48px;
}
@media (max-width: 920px) {
  .page.with-nav { grid-template-columns: 1fr; }
  nav.toc { display: none; }
}
nav.toc { position: sticky; top: 32px; align-self: start; font-size: 13px; }
nav.toc .label { font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--gray-500); margin-bottom: 12px; }
nav.toc a { display: block; padding: 5px 0 5px 12px; border-left: 2px solid var(--gray-300); color: var(--gray-700); border-bottom: none; }
nav.toc a:hover { color: var(--slate); border-color: var(--slate); }
nav.toc a.l2 { padding-left: 24px; font-size: 12.5px; color: var(--gray-500); }
```

## How to use these tokens

- **Always** start with `:root { ... }` and `body { ... }` above. Don't redefine colors elsewhere — reference the variables.
- For headings always go `eyebrow → h1` (the eyebrow is a one-word category label like `WORKFLOW` or `ATTACHMENT`).
- Use **at most one** accent color per page (clay OR olive, not both). Use it for one TLDR / hero card and any primary links. Everything else is neutral.
- Cards (`.card`) for grouping; tables for tabular data; chips for status-y small values.
- No drop-shadows. The hierarchy comes from typography + borders + spacing, not from elevation.
- Use the `.with-nav` two-column layout only when the page has 4+ scannable sections. For short artifacts (≤ 3 sections), single-column `.page` is cleaner.

## Linking to repo files

When the artifact mentions a file path inside the attached repo (paths like `packages/cli/src/main.js`, `docs/architecture/README.md`, `.niis/exports/codemap.json`), render it as a clickable link:

```html
<a class="file-link"
   href="/__niis/source-file?id={ARTIFACT_ID}&path={URL_ENCODED_PATH}"
   target="_blank" rel="noopener">packages/cli/src/main.js</a>
```

Replace `{ARTIFACT_ID}` with the id given in the task (e.g. `codemap`, `workflow`, `project-profile`). The niis server resolves the path against the artifact's recorded root. The link opens in a new tab.

When the artifact references **other artifacts by id** (e.g. `codemap.json`, `project-profile.md` from `.niis/exports/`), use the same pattern with that artifact's id.
