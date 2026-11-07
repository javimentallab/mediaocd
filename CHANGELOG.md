# Changelog

Notable changes to MediaOCD. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [2.2.0] - 2026-11-07

### Upgrading from 2.1.2

- **Rebuild the image** as usual. Your data carries over, and no migration runs.
- **One new request to an outside service, only on demand**: when an administrator presses *Check for updates*, the server asks `api.github.com` for the latest release of MediaOCD. Nothing is sent but the request itself and a `User-Agent` with the version.

### Added

- **Check for updates**, in `Settings → System → About`, for administrators. When you press it, the server asks GitHub for the latest release (`/api/update-check`, eight-second timeout) and says whether you have it. If there is a newer one, it shows its notes and the commands that update a clone, with a button to copy them. It never checks on its own, and nothing is downloaded or installed: an app inside a container cannot replace itself safely.

## [2.1.2] - 2026-11-03

### Removed

- **41 development tools** (Jest, Babel, ESLint, TypeScript, swagger-typescript-api and others) left from when the app was built from source. Nothing used them: the tests run on the test runner of Node, and the image never installed them. The lockfile goes from 1071 packages to 282, and no package of the image changes.

### Security

- That also takes out the advisories those tools carried, none of which reached the image: deepmerge (CVE-2026-93753), glob (CVE-2026-118773), js-yaml (CVE-2025-64718, CVE-2026-53550, CVE-2026-59869, CVE-2026-84375, GHSA-5p4m-2wfm-xmqj), micromatch (CVE-2024-4067), minimatch (CVE-2026-118764), nanoid 3.3.4 (CVE-2024-55565, CVE-2026-67213, CVE-2026-67214, CVE-2026-73086), swagger-typescript-api (CVE-2026-54660, CVE-2026-54661, CVE-2026-54662, CVE-2026-54663, CVE-2026-54664, CVE-2026-54666), tmp (CVE-2025-54798, CVE-2026-44705) and uuid (CVE-2026-41907).

## [2.1.1] - 2026-11-03

### Security

- **`react-router` in the interface bundle: CVE-2025-68470 and CVE-2026-53669** (moderate, open redirect). A path with doubled or mixed slashes, such as `//example.com` or `/\example.com`, could send the browser to another site. MediaOCD uses hash history and no path takes outside data, so no way to exploit them was found, but they are now closed: every path the router resolves goes through the normalisation of the upstream fix. The bundle stays on 6.3.0, as upgrading needs React 18 and it has no source to rebuild, so a scanner that goes by the version alone will still list them.

## [2.1.0] - 2026-11-03

### Upgrading from 2.0.0

- **Rebuild the image**: there is a new dependency. Your data carries over, and no migration runs.
- **The Trakt importer is gone**, see below.
- **New requests to outside services**: the search fetches the titles of your items in other languages from TMDB, IGDB and Open Library, one every second and a half (`TITLES_WARM=0` turns it off). And when a catalogue finds nothing, what you typed can go to Wikipedia to correct its spelling (`SEARCH_SPELLCHECK=0` turns it off).

### Changed

- **Lists**: a search inside each list adds items to it from your library and the catalogues, without opening each one. The Lists page and each list follow the layout with a vertical bar.
- **Calendar**: soft lines, today highlighted, and each release as a discreet label with the icon and colour of its medium.
- **The page of an item**: poster and data, one row of actions, and cards for where to watch, links and history. Actions that were repeated in the dialog of the green icon left the page, and the rarer ones moved to a menu.
- **Progress**: every cover, anywhere, carries a green icon that shows its state and opens one dialog, with the state of the item (pending, in progress, completed, with a chosen date if you want) and how far you are. On books it switches between read and listened. The bar and the percentage live only there, and the red marks on the covers are gone.
- **The watchlist** comes second in the menu, and in Spanish it is called Pendientes.
- **Search** forgives upper and lower case, accents, typos and words written together, and finds a title in any language, or a book by its author.
- **The green icon** stands out on an item with no state at all, to tell it from a pending one.
- **Rotten Tomatoes**: a link on movies and TV shows.
- **Metacritic**: games without a Metascore show the score of its users, in a round badge. Games with no date on one side now match if their title is unique.
- **Jellyfin**: the purple icon on a cover opens the item in Jellyfin.
- **Games, Watched**: its two sections use vertical bars as well. A game you only watched carries an eye instead of the completed icon.
- **Settings**: four sections instead of nine: General (preferences, languages, password, application tokens), Services and alerts (TMDB, IGDB, Jellyfin, YouTube, notifications), Data (backup, restore, export, import, catalog cleanup) and System (about, logs). A menu with icons and cards; each service says whether it is configured and opens when you click it, and notifications show only the chosen platform. The old addresses redirect to the new ones.
- **Upcoming**: the covers, in release order, now follow a vertical bar with a numbered-list symbol and the icons of every media type.
- **In progress, Watchlist, Dropped and Downloaded**: each section is now a row, with a vertical bar as tall as its rows of covers, showing a large icon, the name and the number of items. Sections open unfolded (the last three remember the ones you fold during the session), paging one section no longer affects the others, and Dropped and Downloaded gain a Theater section.

### Removed

- **The Trakt importer.** What you already imported stays: your items, your history and the links of your lists.

### Fixed

- **Saving progress on a show with nothing left to watch** did nothing, without a word. It now goes to its last episode.
- **Abandoned shows** came out as in progress on their covers.
- **In progress and pending** go together: saving progress or marking an episode puts the item in both, and taking it out of pending takes it out of in progress.
- **Reloading a paged list** keeps its page instead of going back to the first one.
- **The details page went blank** when "Where to watch" got an error from the server, as it does without a TMDB key.
- **The covers on the Lists page** came out empty.
- **The "Import from" buttons in Settings** opened the password page instead of the importer.
- Two texts still used the old name of the app.

## [2.0.0] - 2026-11-02

First release under the name MediaOCD (formerly MediaTOC), now a standalone project.

### Upgrading from 1.1.3

- **Your data carries over.** Same files in `/storage` and same port. The database migrations run by themselves on the first start, so take a backup first if you may want to go back to 1.1.3.
- **Rebuild the image.** The app no longer comes from a third-party image patched at build time: its code now lives in this repository (`app/build`, `app/public`), on top of the official Node image.
- **The repository moved** to `github.com/javimentallab/mediaocd`: update your git remote.
- **The example compose file changed names**: service, image and container are now `mediaocd`, and the folders `./mediaocd-data` and `./mediaocd-assets`. If you adopt it, rename your existing folders or keep your volumes pointing at them: a new empty folder means an empty database.
- The image no longer includes `npm`, `npx` or `corepack`.

### Added

- **Sixteen interface languages**: Italian, Dutch, Polish, Russian, Ukrainian, Chinese, Japanese, Thai and Hindi join the existing seven, and the texts of the custom features are now translated in all of them.
- **External scores on the details page**: FilmAffinity for movies and TV shows, Metacritic Metascore for games, cached server-side. `FILMAFFINITY_WARM=0` and `METACRITIC_WARM=0` turn off the background warm-up.
- **Progress in hours and minutes** for movies, games, theatre and TV episodes. Missing episode runtimes are fetched from TMDB when needed and can be corrected by hand.
- **Chapters**: a "Chapter X of N" indicator over the read and listen bars, the real chapter count of Audible audiobooks, and an editable chapter count on the details page, estimated for books.
- **Start page**: choose between Home and In progress.
- **"Mark as in progress" on every media type**, on the details page.
- **Rate anything**: the rating star now shows on items with no release date or a future one.
- **Optional MCP server** in `contrib/mcp-server`, so an AI assistant can search your library, mark items as seen and manage the watchlist and ratings.
- **Optional `contrib/jf-torrents-organize`**: hardlinks qBittorrent downloads into a layout Jellyfin indexes correctly, with season-pack support.
- **Tests of every feature on the front page**, on the real server with a throwaway database and the external services simulated, in CI.
- `README.es.md`, `NOTICE`, `SECURITY.md`, `CONTRIBUTING.md` and this changelog.

### Changed

- **In progress keeps itself tidy**: airing shows stay while you are up to date, an episode watched ahead of its air date no longer drops the show, the card shows the next unaired episode in that case, and a show leaves by itself when its season ends. Sections start open.
- **Watchlist** is ordered by date added. Finished shows leave it when every aired episode is seen, and also when a later metadata refresh reports that the show has ended.
- **Jellyfin downloaded flags are two-way**: items that Jellyfin no longer has are unmarked. Public URLs pasted with a path are reduced to their origin, which fixes "Play in Jellyfin" links.
- **Abandoned items**: resuming one, marking it in progress or adding it to the watchlist also clears the abandoned state and puts it back on the watchlist.
- **Interface**: redesigned collapsible sections and main bar, full-width layout, and centred covers and home page.
- **Speed**: longer server-side cache of item lists, a home page that fills in progressively, and an In progress page that opens with its last response while it refreshes.

### Fixed

- **teatro.es text**: an escaped entity was decoded twice.
- **YouTube duration log**: it no longer copies the OAuth error message.
- **Texts stuck in Spanish in every language**: some fifty texts of the interface, such as the Jellyfin status, "Load durations from TMDB", the Duplicates page, the backup messages, the light and dark mode and the where-to-watch groups, now come from the catalogues in the 16 languages, and dates and the FilmAffinity score follow the interface language. Settings → Backup also warns that an invalid copy is not applied: the current database stays and the file is set aside as `data.db.uploaded.rejected-*`.
- **Texts stuck in English in every language**: Close, Load more, Links, API key, the units of time, the tagline and the names of languages now follow the interface language.
- **Button contrast and spacing**: the Export JSON, Letterboxd CSV, restore and merge buttons now reach at least 4.5:1 in both themes, and icons, chips and buttons no longer touch, because the `gap-*` classes were missing from the compiled CSS.
- **Invisible buttons in the light theme**: colour classes missing from the compiled CSS left white text on a white background on the TMDB key's Save button, the download buttons in Settings → Backup and the refresh button on the Downloaded page, among others. In the dark theme the same gap made descriptions hard to read.
- **Settings → Backup** described a nightly automatic backup that doesn't come with the app. It now says so and points to "Host-side backups" in the README.
- **German search results**: the text for a single result had a broken tag.
- **Phone layout**: the backup table stacks its rows, long log lines wrap, and the TMDB key form and the links row of the details page no longer run off the screen.
- **Example compose file**: with the optional variables commented out it failed validation, so `docker compose build` stopped before building. What the install steps leave in the repository folder is now ignored by git.
- **Portuguese, French and Danish**: many texts were still in English, and the tooltip of the rating stars was in Spanish in every language.
- **`PUT /api/seen/by-external-id`** always answered 500, so the reverse sync with Jellyfin never ran. It now pushes only new marks, only of movies and shows, and only the exact episode.
- **JSON import**: everything came back as played, losing what was only watched. Exports from before there were kinds still import, as played.
- **Restoring an uploaded database**: nothing applied it. It is now applied at the next start if it passes an integrity check and is a MediaOCD database; the current one is kept as `data.db.before-restore-<date>`, with its `-wal` and `-shm` files, and one that fails is set aside and logged.
- README: there is no "attended" verb in the app; theatre counts as seen.
- **Opening the same item from two clients during its first load** answered 500 ("MediaItem 8 is locked") to one of them. The second one now waits for that same update.
- **Sync with Jellyfin**: a mark pushed from MediaOCD would have come back as a second viewing, and something played with no date there added one at every Sync.
- **An item locked by a crash** answered 500 ("is locked") for up to a day. These locks are now cleared at the next start.
- **Errors of the server** that the interface shows as they come were in Spanish in every language. They are now in English.
- **Letterboxd export**: ratings were halved, so 5 stars came out as 2.5. They are now exported as stored.
- Searches with many results failing with "database is locked".
- Returning shows flagged as completed after catching up on the aired episodes.
- Marking a TV episode as complete removing the show from the watchlist and In progress.
- Progress saved in one view not showing up in the others; different page totals on the card and on the details page.
- List pages missing the downloaded flag, so clicking it removed the mark instead of setting it.
- Completed movies, games and books stuck in In progress or on the watchlist.
- Abandoned items missing from the abandoned list.
- Marking a YouTube video as watched failing when YouTube didn't return its duration.
- Reloading any page of the web client answering "Cannot GET".
- Flicker: lists no longer refetch by themselves when the window regains focus or the network comes back, and sections no longer remount about 30 seconds after opening.
- Bulk marking of TV episodes as seen creating duplicates, and failed metadata updates blocking the queue.

### Security

- Node 20 (end of life) replaced by Node 22.23.4 on Alpine 3.23, pinned by digest, which brings the fixes of the October 2026 Node security release: CVE-2026-111497 (Brotli decoder RCE), CVE-2026-105483 and CVE-2026-106069 (TLS hostname bypasses).
- Dependencies: nanoid 3.3.20 (CVE-2026-67213, CVE-2026-67214, CVE-2026-73086), sharp 0.35.5 (GHSA-f88m-g3jw-g9cj), proxy-addr 2.0.8 (CVE-2026-90711), body-parser 1.20.9 (CVE-2026-111181), follow-redirects 1.16.2 (CVE-2026-116689).
- `npm`, `npx` and `corepack` removed from the final image, as they carried their own HIGH advisories.
- CI: Trivy scans the image and the repository for vulnerabilities, secrets and misconfigurations, and CodeQL analyzes the code, on every push and every week. The tests run on every push, and another workflow builds the image, starts it and checks that it answers. Every GitHub Action is pinned by commit.

[2.2.0]: https://github.com/javimentallab/mediaocd/compare/v2.1.2...v2.2.0
[2.1.2]: https://github.com/javimentallab/mediaocd/compare/v2.1.1...v2.1.2
[2.1.1]: https://github.com/javimentallab/mediaocd/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/javimentallab/mediaocd/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/javimentallab/mediaocd/compare/v1.1.3...v2.0.0
