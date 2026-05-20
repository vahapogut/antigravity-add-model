const fs = require('fs');
const logPath = 'C:\\Users\\vahap\\AppData\\Roaming\\Antigravity\\logs\\main.log';

const content = fs.readFileSync(logPath, 'utf-8');
const lines = content.split('\n');

for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('Response for /v1internal:loadCodeAssist')) {
        console.log(`--- loadCodeAssist Match at line ${i} ---`);
        let jsonStr = '';
        for (let j = i + 1; j < i + 100 && j < lines.length; j++) {
            // Find the info/error prefix length (usually like "[2026-05-20 20:13:29.801] [info] ")
            const match = lines[j].match(/^\[[^\]]+\]\s+\[[^\]]+\]\s+(.*)/);
            if (match) {
                const lineContent = match[1];
                jsonStr += lineContent + '\n';
            } else {
                jsonStr += lines[j] + '\n';
            }
        }
        console.log(jsonStr);
        break; // Just print the first one
    }
}
