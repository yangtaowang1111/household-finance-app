require('dotenv').config();
const express = require('express');

require('./db'); // applies schema on startup
const { seedCategories } = require('./db/seed');
const apiKeyAuth = require('./middleware/apiKeyAuth');

const accountsRouter = require('./routes/accounts');
const categoriesRouter = require('./routes/categories');
const transactionsRouter = require('./routes/transactions');
const budgetsRouter = require('./routes/budgets');
const importRouter = require('./routes/import');
const categorizeRouter = require('./routes/categorize');
const syncRouter = require('./routes/sync');

seedCategories();

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api', apiKeyAuth);

app.use('/api/accounts', accountsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/budgets', budgetsRouter);
app.use('/api/import', importRouter);
app.use('/api/categorize', categorizeRouter);
app.use('/api/sync', syncRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Household Finance API listening on port ${PORT}`));
