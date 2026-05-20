const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const targetAsar = "C:\\Users\\vahap\\AppData\\Local\\Programs\\antigravity\\resources\\app.asar";
const backupAsar = "C:\\Users\\vahap\\AppData\\Local\\Programs\\antigravity\\resources\\app.asar.old";

console.log("Safe Repack starting...");

// Check if app.asar exists
if (fs.existsSync(targetAsar)) {
    try {
        console.log("Bypassing Windows file lock by renaming app.asar to app.asar.old...");
        if (fs.existsSync(backupAsar)) {
            try {
                fs.unlinkSync(backupAsar);
            } catch (e) {
                console.log("Could not delete existing app.asar.old, trying to rename it first.");
                const tempOld = backupAsar + "." + Date.now();
                fs.renameSync(backupAsar, tempOld);
            }
        }
        fs.renameSync(targetAsar, backupAsar);
        console.log("Successfully renamed app.asar to app.asar.old!");
    } catch (err) {
        console.error("Failed to rename app.asar. It might be locked by another process that doesn't permit renaming.", err);
    }
}

try {
    console.log("Packaging app.asar...");
    const workspaceDir = "c:\\Users\\vahap\\OneDrive\\Desktop\\antigravity-add-model";
    execSync(`npx -y @electron/asar pack . "${targetAsar}"`, { cwd: workspaceDir, stdio: 'inherit' });
    console.log("==============================================");
    console.log("SUCCESS: app.asar packaged successfully!");
    console.log("==============================================");
} catch (err) {
    console.error("Packaging failed:", err);
    
    // Attempt rollback if packaging failed and we renamed the original
    if (fs.existsSync(backupAsar) && !fs.existsSync(targetAsar)) {
        console.log("Rolling back: renaming app.asar.old back to app.asar...");
        try {
            fs.renameSync(backupAsar, targetAsar);
            console.log("Rollback completed successfully.");
        } catch (rollErr) {
            console.error("Rollback failed!", rollErr);
        }
    }
}
