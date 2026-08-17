require('dotenv').config();
const path = require('path');
const express = require('express');

require('./db'); // applies schema on startup
const { seedTaxonomy } = require('./db/seedTaxonomy');
const apiKeyAuth = require('./middleware/apiKeyAuth');

const accountsRouter = require('./routes/accounts');
const categoriesRouter = require('./routes/categories');
const transactionsRouter = require('./routes/transactions');
const budgetsRouter = require('./routes/budgets');
const importRouter = require('./routes/import');
const categorizeRouter = require('./routes/categorize');
const syncRouter = require('./routes/sync');
const cashflowRouter = require('./routes/cashflow');
const networthRouter = require('./routes/networth');

seedTaxonomy({ log: true });

const app = express();
app.use(express.json());

// The dashboard. Served before the API-key gate because a browser cannot put
// a header on a document request; the page asks for the key itself and calls
// the API with it. Access to the container is already gated by Tailscale.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api', apiKeyAuth);

app.use('/api/accounts', accountsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/budgets', budgetsRouter);
app.use('/api/import', importRouter);
app.use('/api/categorize', categorizeRouter);
app.use('/api/sync', syncRouter);
app.use('/api/cashflow', cashflowRouter);
app.use('/api/networth', networthRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Household Finance API listening on port ${PORT}`));
