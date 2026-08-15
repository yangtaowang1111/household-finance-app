#!/usr/bin/env node
// Daily SimpleFIN sync, meant to be driven by cron on the NAS — the same way
// the 3am database backup is (UGOS has no task scheduler GUI we could find).
//
//   docker exec household-finance-app node scripts/daily-sync.js
//
// Runs balances and transactions off a single SimpleFIN request, then routes
// anything newly imported through the categorizer. Exits non-zero on a failure
// or a partial sync so cron's mail/logs show something went wrong — an
// unattended job that fails silently is worse than one that doesn't run.
//
// Usage: daily-sync.js [--days N] [--include-pending] [--no-categorize]

require('dotenv').config();

const db = require('../src/db');
const { syncAll } = require('../src/services/transactionSync');

function parseArgs(argv) {
  const args = { days: undefined, includePending: false, categorize: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--days') {
      args.days = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--include-pending') {
      args.includePending = true;
    } else if (arg === '--no-categorize') {
      args.categorize = false;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  console.log(`[${startedAt.toISOString()}] starting sync (days=${args.days || 'default'}, pending=${args.includePending})`);

  const result = await syncAll({ days: args.days, includePending: args.includePending });
  const { accounts, transactions, window } = result;

  console.log(`window: ${window.start} -> ${window.end} (${window.days}d)`);
  console.log(`accounts: ${accounts.created} created, ${accounts.updated} updated`);
  console.log(
    `transactions: ${transactions.created} created, ${transactions.updated} updated, ` +
      `${transactions.unchanged} unchanged, ${transactions.pendingSettled} pending settled`
  );

  for (const dup of transactions.possibleDuplicates) {
    console.warn(
      `possible duplicate: synced #${dup.synced_transaction_id} (${dup.date} ${dup.amount} ${dup.merchant}) ` +
        `looks like existing ${dup.existing_source} #${dup.duplicates_transaction_id} — review, nothing was deleted`
    );
  }
  for (const item of transactions.unreconciledPending) {
    console.warn(`pending transaction #${item.transaction_id} (${item.date} ${item.amount} ${item.merchant}) no longer returned and unmatched`);
  }
  for (const account of transactions.unknownAccounts) {
    console.warn(`skipped transactions for unknown account: ${account.name}`);
  }
  for (const skip of transactions.skipped) {
    console.warn(`skipped transaction ${skip.simplefin_id}: ${skip.reason}`);
  }
  for (const err of result.errors) {
    console.error(`SimpleFIN reported: ${err}`);
  }

  // Gated on what is actually uncategorized rather than on what this run
  // imported. `categorizeUncategorized` processes a bounded batch (200 by
  // default, hard-capped at 500) to keep Claude API cost predictable, so a
  // large import leaves a remainder — and a remainder must still get picked up
  // on a following night that happened to import nothing.
  const uncategorized = db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL')
    .get().n;

  // Categorization is best-effort: a sync that imported real transactions has
  // already done the part that's hard to redo, and the categorizer can be
  // re-run at any time against whatever is still uncategorized.
  if (args.categorize && uncategorized > 0) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('ANTHROPIC_API_KEY is not set — imported transactions are left uncategorized');
    } else {
      try {
        const { categorizeUncategorized } = require('../src/services/categorizer');
        const counts = await categorizeUncategorized();
        console.log(
          `categorized: ${counts.ruleMatched} by rule, ${counts.aiCategorized} by AI ` +
            `(${counts.needsReview} low confidence), ${counts.rulesLearned} rules learned`
        );
        const remaining = db
          .prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL')
          .get().n;
        if (remaining > 0) {
          console.log(`${remaining} transactions still uncategorized — the next run will continue`);
        }
      } catch (err) {
        console.error(`categorization failed (transactions were still imported): ${err.message}`);
        process.exitCode = 1;
      }
    }
  }

  console.log(`[${new Date().toISOString()}] sync ${result.status}`);
  if (result.status !== 'success') process.exitCode = 1;
}

main().catch((err) => {
  console.error(`sync failed: ${err.message}`);
  process.exit(1);
});
