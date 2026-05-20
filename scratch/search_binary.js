const fs = require('fs');

const binPath = 'C:\\Users\\vahap\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe';
if (!fs.existsSync(binPath)) {
    console.error('Binary not found');
    process.exit(1);
}

const buffer = fs.readFileSync(binPath);
console.log('Read binary of size:', buffer.length);

function searchStrings(buf, searchWords) {
    let currentString = '';
    const results = new Set();
    for (let i = 0; i < buf.length; i++) {
        const char = buf[i];
        if (char >= 32 && char <= 126) {
            currentString += String.fromCharCode(char);
        } else {
            if (currentString.length >= 4) {
                for (const word of searchWords) {
                    if (currentString.toLowerCase().includes(word.toLowerCase())) {
                        results.add(currentString);
                    }
                }
            }
            currentString = '';
        }
    }
    return Array.from(results);
}

const keywords = ['daily-cloudcode', 'cloudcode', 'CLOUD_CODE', 'CCPA_API', 'fetchAvailableModels'];
const found = searchStrings(buffer, keywords);
console.log('Found strings:');
found.forEach(s => console.log('  ', s));
