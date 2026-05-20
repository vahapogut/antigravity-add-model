const fs = require('fs');
const path = require('path');

const binPath = 'C:\\Users\\vahap\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe';
const oldPath = binPath + '.old';
const backupPath = binPath + '.bak';

console.log('Starting safe binary patching...');

// 1. Create a backup if not already done (using oldPath or binPath)
if (!fs.existsSync(backupPath)) {
    if (fs.existsSync(binPath)) {
        console.log('Creating initial backup...');
        fs.copyFileSync(binPath, backupPath);
        console.log('Backup created at:', backupPath);
    }
}

// 2. Rename the running binary to .old (Windows allows this!)
try {
    if (fs.existsSync(oldPath)) {
        console.log('Removing previous .old file...');
        fs.unlinkSync(oldPath);
    }
    
    console.log('Renaming running binary to .old to bypass Windows file locks...');
    fs.renameSync(binPath, oldPath);
    console.log('Successfully renamed to:', oldPath);
} catch (err) {
    console.error('Failed to rename binary:', err);
    if (!fs.existsSync(oldPath)) {
        console.error('Renaming failed and no .old exists. Cannot proceed.');
        process.exit(1);
    }
    console.log('Proceeding with existing .old file...');
}

// 3. Read the binary from the .old file
console.log('Reading binary from:', oldPath);
const buffer = fs.readFileSync(oldPath);
console.log('Binary size:', buffer.length);

const target = 'https://daily-cloudcode-pa.googleapis.com';
const replacement = 'http://127.0.0.1:50999/dummy_path_padding';

if (target.length !== replacement.length) {
    console.error(`Error: Target length (${target.length}) does not match replacement length (${replacement.length})!`);
    process.exit(1);
}

const targetBuf = Buffer.from(target);
const repBuf = Buffer.from(replacement);

let occCount = 0;
let idx = 0;
while (true) {
    idx = buffer.indexOf(targetBuf, idx);
    if (idx === -1) break;
    
    console.log(`Found occurrence of "${target}" at byte offset ${idx}. Overwriting in memory...`);
    repBuf.copy(buffer, idx);
    occCount++;
    idx += targetBuf.length;
}

if (occCount === 0) {
    console.log('No occurrences found in the binary. It might already be patched or modified.');
}

// 4. Write the patched binary to the original binPath!
console.log('Writing patched binary to:', binPath);
try {
    fs.writeFileSync(binPath, buffer);
    console.log('Patched binary written successfully!');
    console.log('YOU ARE ALL SET! Antigravity does not need to be restarted immediately, but the next time it starts, it will use the patched binary.');
} catch (err) {
    console.error('Failed to write patched binary:', err);
    // Try to restore
    try {
        fs.renameSync(oldPath, binPath);
        console.log('Restored original binary.');
    } catch (restoreErr) {
        console.error('Fatal: Failed to restore original binary:', restoreErr);
    }
    process.exit(1);
}
