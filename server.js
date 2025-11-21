const express = require('express');
const routes = require(`${__dirname}/routes/index`);

// Create an express app
const app = express();

// Add a simple GET route for "/" that returns "Server is running"
app.get('/', (req, res) => {
  res.send('Server is running');
});

// Make the app listen on port 5000
app.listen(5000, () => {
  console.log('Server listening on port 5000');
});