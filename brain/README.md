# Vibink brain

This folder is the only durable Vibink brain. It holds concise, reusable learnings that the owner explicitly asks Vibink to remember.

The storage contract is deliberately narrow:

- Writes require `owner_confirmed: true`; inferred or pending preferences are not eligible.
- Only `design`, `interaction`, `project`, and `workflow` are valid categories. Record and list inputs cannot supply a filesystem path.
- Learning IDs are random opaque identifiers. Titles never become directory names.
- Page or DOM text, URLs, selectors, diagnostics, screenshots or image data, voice transcripts, pairing data, secrets, credentials, and person data are prohibited.
- Input is rejected if safety redaction or normalization would change it. Over-length or over-size input is rejected, never truncated.
- Counts, revisions, returned list results, and JSON revision size are bounded.
- An exclusive repository-local write lock serializes simultaneous bridge tasks so count limits and superseding revision chains remain consistent.
- The lock is never stolen merely because it is old. If a process crash leaves `brain/.vibink-write.lock`, stop every Vibink bridge before removing that exact ignored file manually.
- Revisions are immutable JSON files. Updating an existing opaque learning ID appends a revision that names the prior valid revision; it never overwrites history.

Automated checks reject common unsafe payloads, but they cannot prove that prose is free of sensitive context. The caller and owner must provide a sanitized summary rather than copied source material.

Categories:

- `design/` — stable visual preferences and design principles.
- `interaction/` — preferred collaboration and input behavior.
- `project/` — reusable non-sensitive repository conventions.
- `workflow/` — repeatable development and operating practices.

Each learning has its own opaque directory and immutable timestamped revisions. Listing returns the newest valid revision and falls back to an older valid revision when a newer file is corrupt or invalid. Review this folder before committing; no redaction filter replaces human judgment.
