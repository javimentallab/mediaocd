"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.up = void 0;
exports.down = void 0;
// Indexes for the per-item subqueries of the item lists (knex/queries/items.js).
async function up(knex) {
  // Upcoming, last aired and first unwatched episode of a show: one seek by show and
  // season-episode number, instead of every show that has an S01E01.
  await knex.raw('CREATE INDEX IF NOT EXISTS episode_tvshow_sae_idx ON episode(tvShowId, seasonAndEpisodeNumber)');
  // Last seen date and the watched/played flags of an item, read from the index alone.
  await knex.raw('CREATE INDEX IF NOT EXISTS seen_user_media_kind_date_idx ON seen(userId, mediaItemId, kind, date)');
}
async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS episode_tvshow_sae_idx');
  await knex.raw('DROP INDEX IF EXISTS seen_user_media_kind_date_idx');
}
exports.up = up;
exports.down = down;
