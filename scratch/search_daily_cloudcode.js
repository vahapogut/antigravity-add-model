const fs = require('fs');
const binPath = 'C:\\Users\\vahap\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe';

if (!fs.existsSync(binPath)) {
    console.error('Binary not found');
    process.exit(1);
}

const buffer = fs.readFileSync(binPath);
console.log('Read binary of size:', buffer.length);

function findOccurrences(pattern) {
    const patBuf = Buffer.from(pattern);
    const results = [];
    let pos = 0;
    while (true) {
        const idx = buffer.indexOf(patBuf, pos);
        if (idx === -1) break;
        results.push(idx);
        pos = idx + 1;
    }
    return results;
}

const pattern = 'daily-cloudcode';
const occs = findOccurrences(pattern);
console.log(`Found ${occs.length} occurrences of "${pattern}":`);
occs.forEach(idx => {
    const start = Math.max(0, idx - 40);
    const end = Math.min(buffer.length, idx + pattern.length + 40);
    const context = buffer.slice(start, end).toString('utf-8').replace(/[\r\n\0]/g, ' ');
    console.log(`At ${idx}: ... ${context} ...`);
});
