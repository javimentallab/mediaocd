"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.down = down;
exports.up = up;
// How a book was consumed, 'read' or 'listen', as chosen in the status dialog. NULL means
// never chosen: the interface then falls back to looking at the listening progress.
async function up(knex) {
  const has = await knex.schema.hasColumn('mediaItem', 'bookMode');
  if (!has) {
    await knex.schema.alterTable('mediaItem', table => {
      table.string('bookMode');
    });
  }
}
async function down(knex) {
  const has = await knex.schema.hasColumn('mediaItem', 'bookMode');
  if (has) {
    await knex.schema.alterTable('mediaItem', table => {
      table.dropColumn('bookMode');
    });
  }
}
