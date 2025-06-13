const express = require('express');
const dotenv = require('dotenv');
const connectDB = require('./config/db');
const cors = require('cors');

dotenv.config();
connectDB();

const app = express();
app.use(cors());
app.use(express.json());

// Routes (example)
app.use('/api/auth', require('./routes/auth.routes'));

app.use((req, res) => res.status(404).send('API route not found'));

module.exports = app;
