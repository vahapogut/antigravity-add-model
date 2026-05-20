const fs = require('fs');

const binPath = 'C:\\Users\\vahap\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe';
const buffer = fs.readFileSync(binPath);

// Search for all MODEL_ strings
let currentString = '';
const results = new Set();
for (let i = 0; i < buffer.length; i++) {
    const char = buffer[i];
    if (char >= 32 && char <= 126) {
        currentString += String.fromCharCode(char);
    } else {
        if (currentString.length >= 8 && currentString.startsWith('MODEL_')) {
            // Only keep clean enum-like values
            if (/^MODEL_[A-Z0-9_]+$/.test(currentString)) {
                results.add(currentString);
            }
        }
        currentString = '';
    }
}

const sorted = Array.from(results).sort();
console.log(`Found ${sorted.length} MODEL_ enum values:`);
sorted.forEach(s => console.log('  ', s));
