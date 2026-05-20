const fs = require('fs');
const logPath = 'C:\\Users\\vahap\\AppData\\Roaming\\Antigravity\\logs\\main.log';

const content = fs.readFileSync(logPath, 'utf-8');
const lines = content.split('\n');

for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('Response for /v1internal:loadCodeAssist')) {
        console.log(`--- loadCodeAssist Match at line ${i} ---`);
        let jsonStr = '';
        for (let j = i + 1; j < i + 100 && j < lines.length; j++) {
            if (lines[j].startsWith('[')) {
                // Next log entry started
                break;
            }
            jsonStr += lines[j] + '\n';
        }
        console.log(jsonStr);
    }
}
