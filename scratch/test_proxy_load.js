const http = require('http');
const fs = require('fs');

const data = JSON.stringify({});

const options = {
  hostname: '127.0.0.1',
  port: 62453,
  path: '/v1internal:loadCodeAssist',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'User-Agent': 'antigravity-test'
  }
};

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
  res.setEncoding('utf8');
  let body = '';
  res.on('data', (chunk) => {
    body += chunk;
  });
  res.on('end', () => {
    fs.writeFileSync('scratch/proxy_response.json', body);
    console.log('Response saved to scratch/proxy_response.json, length:', body.length);
  });
});

req.on('error', (e) => {
  console.error(`problem with request: ${e.message}`);
});

req.write(data);
req.end();
