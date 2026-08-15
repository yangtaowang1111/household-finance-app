const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'finance.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migrations first, then schema.sql. schema.sql only creates what is missing,
// so it can never alter a table that already exists — migrations cover that.
// The order matters: schema.sql declares indexes over columns the migrations
// add, so running it first fails on a database predating those columns.
const { migrate } = require('./migrate');
migrate(db, { log: true });

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

module.exports = db;
