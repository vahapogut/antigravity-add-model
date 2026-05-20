const fs = require('fs');
const path = require('path');

const logPath = 'C:\\Users\\vahap\\AppData\\Roaming\\Antigravity\\logs\\main.log';
if (!fs.existsSync(logPath)) {
    console.error('Log file does not exist');
    process.exit(1);
}

const content = fs.readFileSync(logPath, 'utf-8');
const lines = content.split('\n');

for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('fetchAvailableModels response content:')) {
        console.log(`--- Match at line ${i} ---`);
        for (let j = i; j < i + 100 && j < lines.length; j++) {
            console.log(lines[j]);
        }
    }
}
