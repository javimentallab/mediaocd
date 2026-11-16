# Changelog

Notable changes to MediaOCD. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-11-16

### Added
- The status dialog of an item or an episode has a + and a − beside its completed tile, with the number of times it was completed in between. + adds one more entry to the seen history, with the date you choose; − deletes the latest entry, and with only one left it does the same as "Remove completed".

### Changed
- The date pop-up of the seen history looks like the status dialog.
- The episodes page keeps the actions of a season (add to a list, mark the season as seen or unseen, load durations from TMDB) in a "…" menu, like the details page. Each episode is handled from its green icon, so episode rows and the page of an episode no longer have buttons of their own.
- "Progress:" and its time sit together, centred, in the status dialog.

### Removed
- The "Choose date" link under the tiles of the status dialog: its + does the same.
- "Add episode to list" on the page of an episode.

## [1.0.0] - 2026-11-09

First release, under the PolyForm Noncommercial License 1.0.0.

### Added
- Films, series, games, books, audiobooks and theatre tracked in one place, with a search that tolerates typing errors and works across languages.
- A book can be saved as read or listened to, and the icon on its cover follows that choice.
- Ratings and reviews are saved together with the Save button.
- An estimated duration for plays, from their printed edition, on each play's page and in the home summary.
- A two-column summary on the home page.

### Security
- React Router 6.3.0 carries the fixes for CVE-2025-68470 and CVE-2026-53669.
