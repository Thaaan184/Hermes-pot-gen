'use strict';

const http = require('http');
const serveStatic = require('serve-static');
const finalhandler = require('finalhandler');
const path = require('path');

const serve = serveStatic(path.join(__dirname, 'public'), { index: ['index.html'] });

const server = http.createServer(function (req, res) {
  serve(req, res, finalhandler(req, res));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[studio-web] serving on port ${PORT}`);
});
