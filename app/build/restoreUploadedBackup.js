"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.applyUploadedBackup = exports.UPLOADED_BACKUP_PATH = void 0;
var _fs = require("fs");
var _config = require("./config");
var _logger = require("./logger");
// Applies the database uploaded with POST /api/backup/restore. It runs while the app starts,
// after the logger is ready and before anything opens the database, so nothing is using the
// file it replaces. This is why it is here and not in docker/entrypoint.sh: there it would
// have no SQLite to check the file with and no way to write to the log of the app.

const UPLOADED_BACKUP_PATH = exports.UPLOADED_BACKUP_PATH = '/storage/data.db.uploaded';
const REQUIRED_TABLES = ['knex_migrations', 'configuration', 'mediaItem', 'seen', 'user'];
const DATABASE_FILES = ['', '-wal', '-shm'];

const dateForName = now => now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');

function unusedName(name) {
  let candidate = name;
  for (let i = 2; DATABASE_FILES.some(suffix => (0, _fs.existsSync)(candidate + suffix)); i += 1) {
    candidate = `${name}-${i}`;
  }
  return candidate;
}

// What is wrong with the file, or null. Opening a database in WAL mode, even to read it,
// leaves its -wal and -shm files behind, and they would be taken for those of the database.
function problemWithBackup(file, migrationsDirectory) {
  let db;
  try {
    // Here and not at the top: an install on another database never loads it.
    const _betterSqlite = require("better-sqlite3");
    db = new _betterSqlite(file, {
      readonly: true,
      fileMustExist: true
    });
    const integrity = db.pragma('integrity_check').map(row => row.integrity_check);
    if (integrity.length !== 1 || integrity[0] !== 'ok') {
      return `it failed the integrity check (${integrity.slice(0, 3).join('; ')})`;
    }
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    const missing = REQUIRED_TABLES.filter(table => !tables.has(table));
    if (missing.length > 0) {
      return `it is not a MediaOCD database (no table ${missing.join(', ')})`;
    }
    // The start would stop here anyway: knex refuses a database with migrations it does not know.
    const known = new Set((0, _fs.readdirSync)(migrationsDirectory));
    const unknown = db.prepare('SELECT name FROM knex_migrations').all().map(row => row.name).filter(name => !known.has(name));
    if (unknown.length > 0) {
      return `it comes from a newer version of MediaOCD (unknown migration ${unknown[0]})`;
    }
    return null;
  } catch (error) {
    return `it cannot be read (${error.message})`;
  } finally {
    try {
      if (db) db.close();
    } catch (_) {/* the file is going to be set aside or checked again */}
    for (const suffix of DATABASE_FILES.slice(1)) {
      (0, _fs.rmSync)(file + suffix, {
        force: true
      });
    }
  }
}

/**
 * The current database and its -wal and -shm files are renamed, not copied: nothing written
 * is lost, opening the kept name reads all of it, and the disk needs no extra room. The upload
 * becomes the database with a rename too, so it cannot be applied twice.
 */
function applyUploadedBackup(options = {}) {
  const {
    databasePath = _config.Config.DATABASE_PATH,
    uploadedPath = UPLOADED_BACKUP_PATH,
    migrationsDirectory = _config.Config.MIGRATIONS_DIRECTORY,
    log = _logger.logger,
    now = new Date()
  } = options;
  if (_config.Config.DATABASE_CLIENT !== 'better-sqlite3' || !(0, _fs.existsSync)(uploadedPath)) {
    return {
      status: 'none'
    };
  }
  const problem = problemWithBackup(uploadedPath, migrationsDirectory);
  if (problem) {
    const rejected = unusedName(`${uploadedPath}.rejected-${dateForName(now)}`);
    try {
      (0, _fs.renameSync)(uploadedPath, rejected);
      log.error(`Restore: the uploaded backup was not applied: ${problem}. It is now ${rejected}, and the app starts with the current database.`);
    } catch (error) {
      log.error(`Restore: the uploaded backup was not applied: ${problem}. It could not be set aside (${error.message}) and will be checked again at the next start.`);
    }
    return {
      status: 'rejected',
      problem,
      rejected
    };
  }
  const present = DATABASE_FILES.filter(suffix => (0, _fs.existsSync)(databasePath + suffix));
  const kept = present.length > 0 ? unusedName(`${databasePath}.before-restore-${dateForName(now)}`) : null;
  const moved = [];
  try {
    for (const suffix of present) {
      (0, _fs.renameSync)(databasePath + suffix, kept + suffix);
      moved.push(suffix);
    }
    (0, _fs.renameSync)(uploadedPath, databasePath);
  } catch (error) {
    for (const suffix of moved) {
      (0, _fs.renameSync)(kept + suffix, databasePath + suffix);
    }
    log.error(`Restore: the uploaded backup could not be applied (${error.message}). The app starts with the current database, and it will be tried again at the next start.`);
    return {
      status: 'failed',
      error: error.message
    };
  }
  log.info(`Restore: the uploaded backup is now the database. ${kept ? `The previous one is kept as ${kept}.` : 'There was no previous one.'}`);
  return {
    status: 'applied',
    kept
  };
}
exports.applyUploadedBackup = applyUploadedBackup;
