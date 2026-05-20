const fs = require('fs');
const path = require('path');

const filePath = 'c:\\Users\\vahap\\OneDrive\\Desktop\\antigravity-add-model\\dist\\proxy.js';
let content = fs.readFileSync(filePath, 'utf-8');

const targetStr = "const targetUrl = isCloudCodeUrl ? 'http://127.0.0.1:50999' : 'http://127.0.0.1:50999';";
const replacementStr = "const targetUrl = isCloudCodeUrl ? ('https://' + 'daily-cloudcode-pa.googleapis.com') : ('https://' + 'generativelanguage.googleapis.com');";

if (content.includes(targetStr)) {
    content = content.replace(targetStr, replacementStr);
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log('Successfully replaced targetUrl in proxy.js!');
} else {
    console.log('Target string not found in proxy.js!');
}
