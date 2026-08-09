# Reference leak sanity gate

`npm run sanity:reference-leaks` is a release-blocking clean-room check. It scans:

- every Git-tracked or non-ignored candidate text file in the Niis tree
- added diff lines relative to the locally available merge base
- ignored output under common generated, build, distribution, and coverage directories
- every text file and path in a temporary `npm pack` artifact
- a freshly built and extracted npx distributable, including bundled dependencies

Binary files are skipped after content inspection; BOM-marked UTF-16 text is
decoded and scanned. Text findings report only the file, line, and neutral
fingerprint ID; matched content is never echoed.

## Add a fingerprint

Register hashes for every value the gate must detect:

- project and organization names
- repository coordinates
- canonical and alternate URLs
- namespaces
- absolute local paths

Run the hash command without placing the input in a tracked file:

```sh
npm run sanity:reference-hash -- --id reference-NNN --match stream
```

Enter exactly one value on standard input and close the stream. Copy only the
returned hash fields into `config/reference-fingerprints.json`. Use sequential,
neutral IDs. The configuration loader rejects labels, descriptions, and any
other field that could carry plaintext. SHA-256 remains the authoritative match;
the additional rolling digest is an O(n) prefilter and is always verified
against SHA-256 before a finding is emitted.

`stream` matching is the default. It removes non-alphanumeric separators after
Unicode normalization, case folding, and UTF-8 percent decoding, so spelling
variants, paths, coordinates, and URL forms converge, including across line
boundaries. `token` matching is reserved for short standalone namespaces; it
recognizes grouped separators and separated initials without matching arbitrary
substrings inside longer identifiers.

## Ambiguous interoperability terms

Some product names can also be legitimate API identifiers, adapter names, or
language syntax. The gate does not globally ban such an ambiguous bare token.
Instead, it hashes the source-specific repository coordinate, URL, namespace,
and uniquely reference-derived phrases, while the tracked tree removes those
reference contexts. Genuine interoperability and syntax usages remain valid.
This is a syntax/semantic distinction applied by fingerprint scope; there is no
path allowlist that can hide a finding.

## Verification

Run the focused checker tests with:

```sh
node --test scripts/reference-leak-sanity.test.mjs
```

Run the complete gate with:

```sh
npm run sanity:reference-leaks
```

Set `SANITY_MERGE_BASE` to an existing local revision when CI or a release branch
needs an explicit comparison base. CI checks out full history and the checker
fails closed there if no merge base can be resolved. Root-package inspection
invokes `npm pack` with lifecycle scripts disabled and an isolated temporary npm
cache, preventing a `prepack` recursion and avoiding user-state writes. The npx
builder writes only to a disposable directory; the checker extracts and scans
the resulting tarball with no source-tree exclusions.
