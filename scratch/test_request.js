const https = require('https');

const data = JSON.stringify({});

const options = {
  hostname: 'daily-cloudcode-pa.googleapis.com',
  port: 443,
  path: '/v1internal:loadCodeAssist',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = https.request(options, res => {
  console.log(`statusCode: ${res.statusCode}`);
  console.log('headers:', res.headers);

  let body = [];
  res.on('data', d => {
    body.push(d);
  });

  res.on('end', () => {
    const fullBody = Buffer.concat(body);
    const encoding = res.headers['content-encoding'];
    if (encoding === 'gzip') {
      const zlib = require('zlib');
      zlib.gunzip(fullBody, (err, decoded) => {
        if (err) {
          console.error('Failed to gunzip:', err);
        } else {
          console.log('Decoded body:', decoded.toString('utf-8'));
        }
      });
    } else {
      console.log('Body:', fullBody.toString('utf-8'));
    }
  });
});

req.on('error', error => {
  console.error(error);
});

req.write(data);
req.end();
