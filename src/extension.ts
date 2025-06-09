// extension.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function activate(context: vscode.ExtensionContext) {
    console.log('Git Patch Extension is now active');

    let disposable = vscode.commands.registerCommand('git-patch.applyPatch', async () => {
        try {
            // 1. Prompt user to select a patch file
            const fileUris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'Patch Files': ['patch', 'diff']
                },
                title: 'Select Git Patch File'
            });

            if (!fileUris || fileUris.length === 0) {
                return;
            }

            const patchFilePath = fileUris[0].fsPath;
            const workspaceFolders = vscode.workspace.workspaceFolders;
            
            if (!workspaceFolders) {
                vscode.window.showErrorMessage('No workspace folder is open');
                return;
            }

            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            
            // 2. Read the patch file
            const patchContent = fs.readFileSync(patchFilePath, 'utf8');
            
            // 3. Parse the patch file to extract file changes
            const fileChanges = parsePatchFile(patchContent);
            
            // 4. Filter out unsupported files and prepare for batch processing
            const supportedChanges: Array<{change: FileChange, targetFilePath: string, tempFilePath: string, newContent: string}> = [];
            const deletedFiles: Array<{change: FileChange, targetFilePath: string}> = [];
            
            for (const change of fileChanges) {
                const targetFilePath = path.join(workspaceRoot, change.filePath);
                
                // Handle different file types
                if (change.fileType === 'directory') {
                    vscode.window.showInformationMessage(`Skipping directory: ${change.filePath}`);
                    continue;
                }
                
                if (change.fileType === 'binary') {
                    vscode.window.showInformationMessage(`Skipping binary file: ${change.filePath} (not supported in this version)`);
                    continue;
                }
                
                const targetFileExists = fs.existsSync(targetFilePath);
                
                // Handle deleted files separately
                if (change.isDeleted) {
                    if (targetFileExists) {
                        deletedFiles.push({ change, targetFilePath });
                    }
                    continue;
                }
                
                // Skip if target is a directory
                if (targetFileExists && fs.statSync(targetFilePath).isDirectory()) {
                    vscode.window.showWarningMessage(`Skipping ${change.filePath} because it is a directory`);
                    continue;
                }
                
                let originalContent = '';
                if (targetFileExists) {
                    try {
                        originalContent = fs.readFileSync(targetFilePath, 'utf8');
                    } catch (error) {
                        vscode.window.showErrorMessage(`Error reading ${change.filePath}: ${error instanceof Error ? error.message : String(error)}`);
                        continue;
                    }
                }
                
                // Apply changes to create new content
                const newContent = applyPatchToContent(originalContent, change);
                
                // Create temporary file with the changes applied
                const tempFilePath = path.join(workspaceRoot, `.temp_${path.basename(change.filePath)}`);
                
                // Ensure temp directory exists
                const tempDir = path.dirname(tempFilePath);
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }
                
                try {
                    fs.writeFileSync(tempFilePath, newContent);
                    supportedChanges.push({ change, targetFilePath, tempFilePath, newContent });
                } catch (error) {
                    vscode.window.showErrorMessage(`Error creating temp file for ${change.filePath}: ${error instanceof Error ? error.message : String(error)}`);
                    continue;
                }
            }
            
            // 5. Show summary and ask for single approval
            const totalFiles = supportedChanges.length + deletedFiles.length;
            if (totalFiles === 0) {
                vscode.window.showInformationMessage('No supported files found in patch');
                return;
            }
            
            const fileList = [
                ...supportedChanges.map(item => item.change.filePath),
                ...deletedFiles.map(item => `${item.change.filePath} (delete)`)
            ];
            
            const applyPatch = await vscode.window.showInformationMessage(
                `Apply patch to ${totalFiles} file(s)?\n\nFiles to be modified:\n${fileList.join('\n')}`,
                'Yes', 'No', 'Preview Changes'
            );
            
            if (applyPatch === 'No') {
                // Clean up temp files
                for (const item of supportedChanges) {
                    try {
                        if (fs.existsSync(item.tempFilePath)) {
                            fs.unlinkSync(item.tempFilePath);
                        }
                    } catch (error) {
                        console.log(`Error cleaning up temp file: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
                return;
            }
            
            // 6. If user wants to preview, show live diff preview
            if (applyPatch === 'Preview Changes') {
                const accepted = await showLiveDiffPreview(supportedChanges, deletedFiles);
                
                if (!accepted) {
                    // Clean up temp files
                    for (const item of supportedChanges) {
                        try {
                            if (fs.existsSync(item.tempFilePath)) {
                                fs.unlinkSync(item.tempFilePath);
                            }
                        } catch (error) {
                            console.log(`Error cleaning up temp file: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                    return;
                }
            }
            
            // 7. Apply all changes
            let successCount = 0;
            let errorCount = 0;
            
            // Apply file modifications
            for (const item of supportedChanges) {
                try {
                    // Create directory if it doesn't exist (for new files)
                    const targetDir = path.dirname(item.targetFilePath);
                    if (!fs.existsSync(targetDir)) {
                        fs.mkdirSync(targetDir, { recursive: true });
                    }
                    
                    // Apply changes
                    fs.writeFileSync(item.targetFilePath, item.newContent);
                    successCount++;
                } catch (error) {
                    vscode.window.showErrorMessage(`Error applying changes to ${item.change.filePath}: ${error instanceof Error ? error.message : String(error)}`);
                    errorCount++;
                }
                
                // Clean up temporary file
                try {
                    if (fs.existsSync(item.tempFilePath)) {
                        fs.unlinkSync(item.tempFilePath);
                    }
                } catch (error) {
                    console.log(`Error cleaning up temp file: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            
            // Apply file deletions
            for (const item of deletedFiles) {
                try {
                    fs.unlinkSync(item.targetFilePath);
                    successCount++;
                } catch (error) {
                    vscode.window.showErrorMessage(`Error deleting ${item.change.filePath}: ${error instanceof Error ? error.message : String(error)}`);
                    errorCount++;
                }
            }
            
            // Show final result
            if (errorCount === 0) {
                vscode.window.showInformationMessage(`Patch applied successfully to ${successCount} file(s)`);
            } else {
                vscode.window.showWarningMessage(`Patch applied to ${successCount} file(s) with ${errorCount} error(s)`);
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(`Error applying patch: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    context.subscriptions.push(disposable);

    // Alternative approach using git command directly
    let gitApplyDisposable = vscode.commands.registerCommand('git-patch.applyPatchWithGit', async () => {
        try {
            // 1. Prompt user to select a patch file
            const fileUris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'Patch Files': ['patch', 'diff']
                },
                title: 'Select Git Patch File'
            });

            if (!fileUris || fileUris.length === 0) {
                return;
            }

            const patchFilePath = fileUris[0].fsPath;
            const workspaceFolders = vscode.workspace.workspaceFolders;
            
            if (!workspaceFolders) {
                vscode.window.showErrorMessage('No workspace folder is open');
                return;
            }

            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            
            // 2. First show the changes without applying them (--check)
            await execAsync(`git apply --check "${patchFilePath}"`, { cwd: workspaceRoot });
            
            // 3. Show what would be changed (--numstat)
            const { stdout } = await execAsync(`git apply --numstat "${patchFilePath}"`, { cwd: workspaceRoot });
            const changedFiles = stdout.split('\n')
                .filter(line => line.trim() !== '')
                .map(line => {
                    const parts = line.split('\t');
                    return parts[2];
                });
            
            // 4. Ask for confirmation
            const applyPatch = await vscode.window.showInformationMessage(
                `Apply patch to ${changedFiles.length} file(s)?\n${changedFiles.join(', ')}`,
                'Yes', 'No'
            );
            
            if (applyPatch !== 'Yes') {
                return;
            }
            
            // 5. Show diff for each file that would be changed
            // First create a temporary index
            const tempIndexFile = path.join(workspaceRoot, '.git', 'temp-index');
            await execAsync(`git apply --cached --index="${tempIndexFile}" "${patchFilePath}"`, { cwd: workspaceRoot });
            
            // For each file, show the diff using VS Code's diff editor
            for (const filePath of changedFiles) {
                const fullPath = path.join(workspaceRoot, filePath);
                const { stdout: diffOutput } = await execAsync(
                    `git diff --no-index -- "${fullPath}" "${fullPath}"`, 
                    { cwd: workspaceRoot, env: { ...process.env, GIT_INDEX_FILE: tempIndexFile } }
                );
                
                // Create a temporary file with the patched content
                const tempFilePath = path.join(workspaceRoot, `.temp_${path.basename(filePath)}`);
                await execAsync(
                    `git show ":${filePath}" > "${tempFilePath}"`, 
                    { cwd: workspaceRoot, env: { ...process.env, GIT_INDEX_FILE: tempIndexFile } }
                );
                
                // Show diff
                await vscode.commands.executeCommand('vscode.diff',
                    vscode.Uri.file(fullPath),
                    vscode.Uri.file(tempFilePath),
                    `${filePath} (Git Patch Preview)`
                );
                
                // Clean up temp file
                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                }
            }
            
            // 6. Apply the patch
            await execAsync(`git apply "${patchFilePath}"`, { cwd: workspaceRoot });
            vscode.window.showInformationMessage('Patch applied successfully');
            
        } catch (error) {
            vscode.window.showErrorMessage(`Error applying patch: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    context.subscriptions.push(gitApplyDisposable);
}

// Function to show live diff preview with accept/reject functionality
async function showLiveDiffPreview(
    supportedChanges: Array<{change: FileChange, targetFilePath: string, tempFilePath: string, newContent: string}>,
    deletedFiles: Array<{change: FileChange, targetFilePath: string}>
): Promise<boolean> {
    return new Promise((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'liveDiffPreview',
            'Live Patch Preview',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: []
            }
        );

        // Create backup of all files for rollback functionality
        const backups = new Map<string, string>();
        for (const item of supportedChanges) {
            if (fs.existsSync(item.targetFilePath)) {
                backups.set(item.targetFilePath, fs.readFileSync(item.targetFilePath, 'utf8'));
            }
        }

        let isApplying = false;
        let changesApplied = false;
        let allFileChanges: Array<{fileName: string, diffData: any}> = [];

        panel.webview.html = getWebviewContent();

        panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'ready':
                        // Start the live preview
                        startLivePreview();
                        break;
                    case 'accept':
                        // Keep all applied changes
                        panel.dispose();
                        resolve(true);
                        break;
                    case 'reject':
                        // Rollback all changes
                        if (changesApplied) {
                            await rollbackChanges(backups, deletedFiles);
                        }
                        panel.dispose();
                        resolve(false);
                        break;
                }
            }
        );

        async function startLivePreview() {
            isApplying = true;
            
            for (let i = 0; i < supportedChanges.length; i++) {
                if (!isApplying) break;
                
                const item = supportedChanges[i];
                
                // Generate and show diff for current file
                const oldContent = fs.existsSync(item.targetFilePath) ? fs.readFileSync(item.targetFilePath, 'utf8') : '';
                const diffData = generateDiff(oldContent, item.newContent, item.change);
                
                // Store for tabs later
                allFileChanges.push({
                    fileName: item.change.filePath,
                    diffData: diffData
                });
                
                panel.webview.postMessage({
                    command: 'updateFile',
                    fileName: item.change.filePath,
                    currentIndex: i + 1,
                    totalFiles: supportedChanges.length + deletedFiles.length,
                    diffData: diffData
                });

                // Play sound effect
                panel.webview.postMessage({ command: 'playSound' });

                // Show changes being applied live with staggered animation
                panel.webview.postMessage({ 
                    command: 'startApplyingChanges',
                    hunks: item.change.hunks
                });
                
                // Apply the change with delay for visual effect
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Create directory if needed
                const targetDir = path.dirname(item.targetFilePath);
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true });
                }
                
                // Apply the change
                fs.writeFileSync(item.targetFilePath, item.newContent);
                changesApplied = true;

                // Update progress
                panel.webview.postMessage({
                    command: 'updateProgress',
                    progress: ((i + 1) / (supportedChanges.length + deletedFiles.length)) * 100
                });

                await new Promise(resolve => setTimeout(resolve, 300));
            }

            // Handle deleted files
            for (let i = 0; i < deletedFiles.length; i++) {
                if (!isApplying) break;
                
                const item = deletedFiles[i];
                
                const oldContent = fs.readFileSync(item.targetFilePath, 'utf8');
                const diffData = generateDeletionDiff(oldContent);
                
                // Store for tabs later
                allFileChanges.push({
                    fileName: `${item.change.filePath} (DELETE)`,
                    diffData: diffData
                });
                
                panel.webview.postMessage({
                    command: 'updateFile',
                    fileName: `${item.change.filePath} (DELETE)`,
                    currentIndex: supportedChanges.length + i + 1,
                    totalFiles: supportedChanges.length + deletedFiles.length,
                    diffData: diffData
                });

                panel.webview.postMessage({ command: 'playSound' });
                
                await new Promise(resolve => setTimeout(resolve, 800));
                
                // Delete the file
                fs.unlinkSync(item.targetFilePath);
                changesApplied = true;

                // Update progress
                panel.webview.postMessage({
                    command: 'updateProgress',
                    progress: ((supportedChanges.length + i + 1) / (supportedChanges.length + deletedFiles.length)) * 100
                });

                await new Promise(resolve => setTimeout(resolve, 300));
            }

            // Show completion and enable buttons with all file tabs
            panel.webview.postMessage({ 
                command: 'showComplete',
                allFiles: allFileChanges
            });
        }

        async function rollbackChanges(backups: Map<string, string>, deletedFiles: Array<{change: FileChange, targetFilePath: string}>) {
            // Restore backed up files
            for (const [filePath, content] of backups) {
                try {
                    fs.writeFileSync(filePath, content);
                } catch (error) {
                    console.error(`Error restoring ${filePath}:`, error);
                }
            }

            // Restore deleted files (they would have been deleted during preview)
            for (const item of deletedFiles) {
                if (backups.has(item.targetFilePath)) {
                    try {
                        fs.writeFileSync(item.targetFilePath, backups.get(item.targetFilePath)!);
                    } catch (error) {
                        console.error(`Error restoring deleted file ${item.targetFilePath}:`, error);
                    }
                }
            }

            // Remove any new files that were created
            for (const item of supportedChanges) {
                if (item.change.isNew && fs.existsSync(item.targetFilePath)) {
                    try {
                        fs.unlinkSync(item.targetFilePath);
                    } catch (error) {
                        console.error(`Error removing new file ${item.targetFilePath}:`, error);
                    }
                }
            }
        }

        panel.onDidDispose(() => {
            isApplying = false;
            // Clean up temp files
            for (const item of supportedChanges) {
                try {
                    if (fs.existsSync(item.tempFilePath)) {
                        fs.unlinkSync(item.tempFilePath);
                    }
                } catch (error) {
                    console.log(`Error cleaning up temp file: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        });
    });
}

// Generate unified diff data for display
function generateDiff(oldContent: string, newContent: string, change: FileChange): any {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    
    const diffLines: Array<{type: 'context' | 'add' | 'remove', content: string, oldLineNum?: number, newLineNum?: number}> = [];
    
    // For new files, show all lines as additions
    if (change.isNew) {
        newLines.forEach((line, index) => {
            diffLines.push({
                type: 'add',
                content: line,
                newLineNum: index + 1
            });
        });
        return { diffLines, isNewFile: true };
    }
    
    // Process each hunk to create a unified diff view
    let oldLineIndex = 0;
    let newLineIndex = 0;
    
    for (const hunk of change.hunks) {
        // Add context before hunk if there's a gap
        const contextStart = Math.max(0, hunk.oldStartLine - 4);
        while (oldLineIndex < contextStart) {
            diffLines.push({
                type: 'context',
                content: oldLines[oldLineIndex],
                oldLineNum: oldLineIndex + 1,
                newLineNum: newLineIndex + 1
            });
            oldLineIndex++;
            newLineIndex++;
        }
        
        // Jump to hunk start
        oldLineIndex = hunk.oldStartLine - 1;
        newLineIndex = hunk.newStartLine - 1;
        
        // Process hunk content
        const hunkLines = hunk.content.split('\n');
        for (const hunkLine of hunkLines) {
            if (hunkLine.startsWith('-')) {
                diffLines.push({
                    type: 'remove',
                    content: hunkLine.substring(1),
                    oldLineNum: oldLineIndex + 1
                });
                oldLineIndex++;
            } else if (hunkLine.startsWith('+')) {
                diffLines.push({
                    type: 'add',
                    content: hunkLine.substring(1),
                    newLineNum: newLineIndex + 1
                });
                newLineIndex++;
            } else {
                // Context line
                diffLines.push({
                    type: 'context',
                    content: hunkLine.substring(1),
                    oldLineNum: oldLineIndex + 1,
                    newLineNum: newLineIndex + 1
                });
                oldLineIndex++;
                newLineIndex++;
            }
        }
    }
    
    // Add some context after the last hunk
    const contextEnd = Math.min(oldLines.length, oldLineIndex + 3);
    while (oldLineIndex < contextEnd) {
        diffLines.push({
            type: 'context',
            content: oldLines[oldLineIndex],
            oldLineNum: oldLineIndex + 1,
            newLineNum: newLineIndex + 1
        });
        oldLineIndex++;
        newLineIndex++;
    }
    
    return { diffLines, isNewFile: false };
}

// Generate diff data for file deletion
function generateDeletionDiff(oldContent: string): any {
    const oldLines = oldContent.split('\n');
    const diffLines = oldLines.map((line, index) => ({
        type: 'remove' as const,
        content: line,
        oldLineNum: index + 1
    }));
    
    return { diffLines, isDeleted: true };
}

function getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Live Patch Preview</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        
        .header {
            text-align: center;
            margin-bottom: 30px;
        }
        
        .progress-container {
            width: 100%;
            height: 6px;
            background: var(--vscode-progressBar-background);
            border-radius: 3px;
            margin-bottom: 20px;
            overflow: hidden;
        }
        
        .progress-bar {
            height: 100%;
            background: var(--vscode-progressBar-background);
            background: linear-gradient(90deg, #007acc, #4fc3f7);
            width: 0%;
            transition: width 0.3s ease;
            border-radius: 3px;
        }
        
        .current-file {
            text-align: center;
            font-size: 16px;
            margin-bottom: 20px;
            min-height: 24px;
        }
        
        .tabs-container {
            margin-bottom: 20px;
            display: none; /* Hidden during live preview */
        }
        
        .tabs-header {
            display: flex;
            background: var(--vscode-tab-inactiveBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            overflow-x: auto;
        }
        
        .tab {
            padding: 8px 16px;
            background: var(--vscode-tab-inactiveBackground);
            color: var(--vscode-tab-inactiveForeground);
            border-right: 1px solid var(--vscode-panel-border);
            cursor: pointer;
            white-space: nowrap;
            min-width: 120px;
            text-align: center;
            font-size: 12px;
        }
        
        .tab.active {
            background: var(--vscode-tab-activeBackground);
            color: var(--vscode-tab-activeForeground);
            border-bottom: 2px solid var(--vscode-focusBorder);
        }
        
        .tab:hover {
            background: var(--vscode-tab-hoverBackground);
        }
        
        .tab-content {
            display: none;
            height: 500px;
            border: 1px solid var(--vscode-panel-border);
            border-top: none;
            overflow: hidden;
        }
        
        .tab-content.active {
            display: block;
        }
        
        .diff-container {
            margin-bottom: 20px;
            height: 500px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            overflow: hidden;
        }
        
        .live-preview-mode .tabs-container {
            display: none;
        }
        
        .review-mode .diff-container {
            display: none;
        }
        
        .review-mode .tabs-container {
            display: block;
        }
        
        .diff-header {
            background: var(--vscode-editor-background);
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-weight: bold;
            font-size: 12px;
        }
        
        .diff-content {
            height: calc(100% - 32px);
            overflow: auto;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: 1.6;
        }
        
        .diff-line {
            display: flex;
            min-height: 1.6em;
            border-left: 4px solid transparent;
        }
        
        .line-numbers {
            display: flex;
            min-width: 80px;
            background: var(--vscode-editor-lineHighlightBackground);
            border-right: 1px solid var(--vscode-panel-border);
            padding: 0 8px;
            color: var(--vscode-editorLineNumber-foreground);
            font-size: 11px;
            user-select: none;
            align-items: center;
        }
        
        .line-content {
            flex: 1;
            padding: 0 12px;
            white-space: pre;
            overflow-x: auto;
        }
        
        .diff-line.add {
            background: rgba(0, 255, 0, 0.1);
            border-left-color: #00ff00;
        }
        
        .diff-line.remove {
            background: rgba(255, 0, 0, 0.1);
            border-left-color: #ff0000;
        }
        
        .diff-line.context {
            background: var(--vscode-editor-background);
        }
        
        .diff-line.add .line-content::before {
            content: '+';
            color: #00ff00;
            margin-right: 8px;
            font-weight: bold;
        }
        
        .diff-line.remove .line-content::before {
            content: '-';
            color: #ff0000;
            margin-right: 8px;
            font-weight: bold;
        }
        
        .diff-line.context .line-content::before {
            content: ' ';
            margin-right: 8px;
        }
        
        .applying-animation {
            animation: applyChange 2s ease-in-out;
        }
        
        .currently-applying {
            background-color: rgba(255, 255, 0, 0.4) !important;
            border-left-color: #ffff00 !important;
            border-left-width: 6px !important;
            transform: scale(1.02);
            box-shadow: 0 0 10px rgba(255, 255, 0, 0.5);
        }
        
        @keyframes applyChange {
            0% { 
                transform: translateX(-20px) scale(0.98); 
                opacity: 0.3; 
                background-color: rgba(255, 255, 0, 0.6);
            }
            25% { 
                transform: translateX(0) scale(1.05); 
                background-color: rgba(255, 255, 0, 0.8);
            }
            50% { 
                transform: translateX(0) scale(1.02); 
                background-color: rgba(255, 255, 0, 0.4);
            }
            100% { 
                transform: translateX(0) scale(1); 
                opacity: 1; 
            }
        }
        
        .scroll-highlight {
            position: relative;
        }
        
        .scroll-highlight::after {
            content: '';
            position: absolute;
            left: 0;
            top: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 0, 0.3), transparent);
            animation: sweep 1s ease-in-out;
        }
        
        @keyframes sweep {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(100%); }
        }
        
        .buttons {
            text-align: center;
            margin-top: 30px;
        }
        
        .button {
            padding: 10px 24px;
            margin: 0 10px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.2s;
        }
        
        .accept-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .accept-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        .reject-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .reject-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .completion-message {
            text-align: center;
            margin: 20px 0;
            font-size: 16px;
            color: var(--vscode-charts-green);
            display: none;
        }
        
        .buzz-animation {
            animation: buzz 0.3s ease-in-out;
        }
        
        @keyframes buzz {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.02); }
        }
    </style>
</head>
<body class="live-preview-mode">
    <div class="header">
        <h1>Live Patch Preview</h1>
        <p>Watch as changes are applied in real-time</p>
    </div>
    
    <div class="progress-container">
        <div class="progress-bar" id="progressBar"></div>
    </div>
    
    <div class="current-file" id="currentFile">Preparing to apply changes...</div>
    
    <!-- Live preview diff container -->
    <div class="diff-container" id="diffContainer">
        <div class="diff-header" id="diffHeader">Diff Preview</div>
        <div class="diff-content" id="diffContent"></div>
    </div>
    
    <!-- Tabbed review interface -->
    <div class="tabs-container" id="tabsContainer">
        <div class="tabs-header" id="tabsHeader">
            <!-- Tabs will be dynamically added here -->
        </div>
        <div class="tabs-content" id="tabsContent">
            <!-- Tab content will be dynamically added here -->
        </div>
    </div>
    
    <div class="completion-message" id="completionMessage">
        ✅ All changes have been applied successfully!
    </div>
    
    <div class="buttons">
        <button class="button accept-btn" id="acceptBtn" disabled onclick="accept()">Accept Changes</button>
        <button class="button reject-btn" id="rejectBtn" disabled onclick="reject()">Reject & Rollback</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        // Audio context for buzz sound
        let audioContext;
        
        function createBuzzSound() {
            if (!audioContext) {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(400, audioContext.currentTime + 0.1);
            
            gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
            
            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.1);
        }
        
        function renderDiff(diffData) {
            const diffContent = document.getElementById('diffContent');
            diffContent.innerHTML = '';
            
            if (!diffData || !diffData.diffLines) {
                diffContent.innerHTML = '<div style="padding: 20px; text-align: center;">No changes to display</div>';
                return;
            }
            
            diffData.diffLines.forEach((line, index) => {
                const diffLine = document.createElement('div');
                diffLine.className = \`diff-line \${line.type}\`;
                diffLine.dataset.lineIndex = index;
                diffLine.dataset.lineType = line.type;
                
                const lineNumbers = document.createElement('div');
                lineNumbers.className = 'line-numbers';
                
                // Show line numbers based on type
                if (line.type === 'remove') {
                    lineNumbers.textContent = (line.oldLineNum || '').toString();
                    diffLine.dataset.oldLineNum = line.oldLineNum;
                } else if (line.type === 'add') {
                    lineNumbers.textContent = (line.newLineNum || '').toString();
                    diffLine.dataset.newLineNum = line.newLineNum;
                } else {
                    // Context line - show both numbers
                    lineNumbers.textContent = \`\${line.oldLineNum || ''}\`;
                    diffLine.dataset.oldLineNum = line.oldLineNum;
                    diffLine.dataset.newLineNum = line.newLineNum;
                }
                
                const lineContent = document.createElement('div');
                lineContent.className = 'line-content';
                lineContent.textContent = line.content || '';
                
                diffLine.appendChild(lineNumbers);
                diffLine.appendChild(lineContent);
                diffContent.appendChild(diffLine);
            });
        }
        
        function startApplyingChanges(hunks) {
            const diffContent = document.getElementById('diffContent');
            const diffLines = diffContent.querySelectorAll('.diff-line');
            
            let animationDelay = 0;
            
            hunks.forEach(hunk => {
                // Find lines that belong to this hunk
                const hunkStartOld = hunk.oldStartLine;
                const hunkStartNew = hunk.newStartLine;
                
                diffLines.forEach(diffLine => {
                    const lineType = diffLine.dataset.lineType;
                    const oldLineNum = parseInt(diffLine.dataset.oldLineNum);
                    const newLineNum = parseInt(diffLine.dataset.newLineNum);
                    
                    // Check if this line is part of the current hunk
                    let isInHunk = false;
                    if (lineType === 'remove' && oldLineNum >= hunkStartOld && oldLineNum < hunkStartOld + hunk.oldLineCount) {
                        isInHunk = true;
                    } else if (lineType === 'add' && newLineNum >= hunkStartNew && newLineNum < hunkStartNew + hunk.newLineCount) {
                        isInHunk = true;
                    } else if (lineType === 'context' && 
                              oldLineNum >= hunkStartOld - 2 && oldLineNum <= hunkStartOld + hunk.oldLineCount + 2) {
                        isInHunk = true;
                    }
                    
                    if (isInHunk && (lineType === 'add' || lineType === 'remove')) {
                        setTimeout(() => {
                            // Scroll to the line
                            diffLine.scrollIntoView({ 
                                behavior: 'smooth', 
                                block: 'center',
                                inline: 'nearest'
                            });
                            
                            // Add highlighting
                            diffLine.classList.add('currently-applying');
                            diffLine.classList.add('scroll-highlight');
                            
                            // Start the animation
                            setTimeout(() => {
                                diffLine.classList.add('applying-animation');
                            }, 200);
                            
                            // Remove highlighting after animation
                            setTimeout(() => {
                                diffLine.classList.remove('currently-applying');
                                diffLine.classList.remove('scroll-highlight');
                                diffLine.classList.remove('applying-animation');
                            }, 2200);
                            
                        }, animationDelay);
                        
                        animationDelay += 300; // Stagger animations
                    }
                });
            });
        }
        
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'updateFile':
                    document.getElementById('currentFile').textContent = 
                        \`Processing (\${message.currentIndex}/\${message.totalFiles}): \${message.fileName}\`;
                    
                    // Update diff header
                    const diffHeader = document.getElementById('diffHeader');
                    diffHeader.textContent = \`\${message.fileName} - Changes\`;
                    
                    // Render the diff
                    renderDiff(message.diffData);
                    
                    // Add buzz animation to diff container
                    const diffContainer = document.getElementById('diffContainer');
                    diffContainer.classList.add('buzz-animation');
                    setTimeout(() => diffContainer.classList.remove('buzz-animation'), 300);
                    break;
                    
                case 'updateProgress':
                    document.getElementById('progressBar').style.width = message.progress + '%';
                    break;
                    
                case 'startApplyingChanges':
                    if (message.hunks && message.hunks.length > 0) {
                        startApplyingChanges(message.hunks);
                    }
                    break;
                    
                case 'playSound':
                    try {
                        createBuzzSound();
                    } catch (e) {
                        console.log('Audio not available');
                    }
                    break;
                    
                case 'showComplete':
                    document.getElementById('currentFile').textContent = 'All changes applied! Review the changes below:';
                    document.getElementById('completionMessage').style.display = 'block';
                    document.getElementById('acceptBtn').disabled = false;
                    document.getElementById('rejectBtn').disabled = false;
                    
                    // Switch to review mode and create tabs
                    if (message.allFiles && message.allFiles.length > 0) {
                        switchToReviewMode(message.allFiles);
                    }
                    break;
            }
        });
        
        function switchToReviewMode(allFiles) {
            // Switch body to review mode
            document.body.classList.remove('live-preview-mode');
            document.body.classList.add('review-mode');
            
            const tabsHeader = document.getElementById('tabsHeader');
            const tabsContent = document.getElementById('tabsContent');
            
            // Clear existing tabs
            tabsHeader.innerHTML = '';
            tabsContent.innerHTML = '';
            
            // Create tabs for each file
            allFiles.forEach((fileData, index) => {
                // Create tab button
                const tab = document.createElement('div');
                tab.className = 'tab' + (index === 0 ? ' active' : '');
                tab.textContent = fileData.fileName.split('/').pop(); // Show just filename
                tab.title = fileData.fileName; // Full path in tooltip
                tab.dataset.tabIndex = index;
                tab.onclick = () => switchTab(index);
                tabsHeader.appendChild(tab);
                
                // Create tab content
                const tabContent = document.createElement('div');
                tabContent.className = 'tab-content' + (index === 0 ? ' active' : '');
                tabContent.id = \`tab-content-\${index}\`;
                
                // Add header
                const header = document.createElement('div');
                header.className = 'diff-header';
                header.textContent = \`\${fileData.fileName} - Changes\`;
                tabContent.appendChild(header);
                
                // Add diff content
                const diffContent = document.createElement('div');
                diffContent.className = 'diff-content';
                tabContent.appendChild(diffContent);
                
                // Render diff for this tab
                renderDiffInContainer(fileData.diffData, diffContent);
                
                tabsContent.appendChild(tabContent);
            });
        }
        
        function switchTab(index) {
            // Update tab buttons
            document.querySelectorAll('.tab').forEach((tab, i) => {
                tab.classList.toggle('active', i === index);
            });
            
            // Update tab content
            document.querySelectorAll('.tab-content').forEach((content, i) => {
                content.classList.toggle('active', i === index);
            });
        }
        
        function renderDiffInContainer(diffData, container) {
            container.innerHTML = '';
            
            if (!diffData || !diffData.diffLines) {
                container.innerHTML = '<div style="padding: 20px; text-align: center;">No changes to display</div>';
                return;
            }
            
            diffData.diffLines.forEach((line, index) => {
                const diffLine = document.createElement('div');
                diffLine.className = \`diff-line \${line.type}\`;
                
                const lineNumbers = document.createElement('div');
                lineNumbers.className = 'line-numbers';
                
                // Show line numbers based on type
                if (line.type === 'remove') {
                    lineNumbers.textContent = (line.oldLineNum || '').toString();
                } else if (line.type === 'add') {
                    lineNumbers.textContent = (line.newLineNum || '').toString();
                } else {
                    // Context line - show both numbers
                    lineNumbers.textContent = \`\${line.oldLineNum || ''}\`;
                }
                
                const lineContent = document.createElement('div');
                lineContent.className = 'line-content';
                lineContent.textContent = line.content || '';
                
                diffLine.appendChild(lineNumbers);
                diffLine.appendChild(lineContent);
                container.appendChild(diffLine);
            });
        }
        
        function accept() {
            vscode.postMessage({ command: 'accept' });
        }
        
        function reject() {
            vscode.postMessage({ command: 'reject' });
        }
        
        // Signal that webview is ready
        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
}

// Helper function to parse a patch file content
// This is a simplified version - a real implementation would need to handle more edge cases
interface FileChange {
    filePath: string;
    fileType: 'file' | 'directory' | 'binary';
    isNew: boolean;
    isDeleted: boolean;
    hunks: {
        oldStartLine: number;
        oldLineCount: number;
        newStartLine: number;
        newLineCount: number;
        content: string;
    }[];
}

function parsePatchFile(patchContent: string): FileChange[] {
    const fileChanges: FileChange[] = [];
    // This is a simplified parser - a real implementation would be more robust
    // Consider using libraries like parse-git-patch instead
    
    // For the example, we'll just do a basic parsing
    const diffFiles = patchContent.split('diff --git');
    
    for (let i = 1; i < diffFiles.length; i++) {
        const diffContent = diffFiles[i];
        const lines = diffContent.split('\n');
        // Remove last line from lines (often an empty line or diff metadata)
        lines.pop();

        // Extract file path
        let filePathMatch = lines[0].match(/a\/(.*) b\/(.*)/);
        
        // Handle cases where paths might not use the standard a/ b/ format
        if (!filePathMatch) {
            // Try a different pattern
            filePathMatch = lines[0].match(/\"(.*)\" \"(.*)\"/);
            if (!filePathMatch) continue;
        }
        
        const targetFilePath = filePathMatch[2];
        
        // Use target path for general operations
        const filePath = targetFilePath;
        
        // Determine file type and operation
        let fileType: 'file' | 'directory' | 'binary' = 'file';
        let isNew = false;
        let isDeleted = false;
        
        // Check file headers for information
        for (let j = 1; j < Math.min(lines.length, 10); j++) {
            const line = lines[j];
            
            // Check for new file
            if (line.includes('new file mode')) {
                isNew = true;
            }
            
            // Check for deleted file
            if (line.includes('deleted file mode')) {
                isDeleted = true;
            }
            
            // Check for binary file
            if (line.includes('Binary files')) {
                fileType = 'binary';
                break;
            }
            
            // Check for directory
            if (line.includes('old mode') && line.includes('new mode') && 
                (line.includes('040000') || line.includes('160000'))) {
                fileType = 'directory';
                break;
            }
        }
        
        // Skip directories for now since we're not handling them
        if (fileType === 'directory') {
            fileChanges.push({
                filePath,
                fileType,
                isNew,
                isDeleted,
                hunks: []
            });
            continue;
        }
        
        // Skip binary files for now
        if (fileType === 'binary') {
            fileChanges.push({
                filePath,
                fileType,
                isNew,
                isDeleted,
                hunks: []
            });
            continue;
        }
        
        const hunks: FileChange['hunks'] = [];
        
        // Find the hunks
        let inHunk = false;
        let currentHunk: FileChange['hunks'][0] = { oldStartLine: 0, oldLineCount: 0, newStartLine: 0, newLineCount: 0, content: '' };
        let hunkHeaderMatch: RegExpMatchArray | null = null;
        
        for (let j = 1; j < lines.length; j++) {
            const line = lines[j];
            
            if (line.startsWith('@@')) {
                // Start of a new hunk
                if (inHunk) {
                    // Remove trailing newline before pushing
                    currentHunk.content = currentHunk.content.replace(/\n$/, '');
                    hunks.push({ ...currentHunk });
                }
                
                // Support both formats:
                // @@ -1,3 +1,4 @@ (showing line count)
                // @@ -1 +1 @@ (single line, no comma)
                hunkHeaderMatch = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
                if (hunkHeaderMatch) {
                    inHunk = true;
                    const oldStartLine = parseInt(hunkHeaderMatch[1], 10);
                    const oldLineCount = hunkHeaderMatch[2] ? parseInt(hunkHeaderMatch[2], 10) : 1;
                    const newStartLine = parseInt(hunkHeaderMatch[3], 10);
                    const newLineCount = hunkHeaderMatch[4] ? parseInt(hunkHeaderMatch[4], 10) : 1;
                    
                    currentHunk = {
                        oldStartLine,
                        oldLineCount,
                        newStartLine,
                        newLineCount,
                        content: ''
                    };
                }
            } else if (inHunk) {
                // Add line to current hunk
                currentHunk.content += line + '\n';
            }
        }
        
        // Add the last hunk
        if (inHunk) {
            currentHunk.content = currentHunk.content.replace(/\n$/, '');
            hunks.push({ ...currentHunk });
        }
        
        fileChanges.push({ 
            filePath, 
            fileType, 
            isNew, 
            isDeleted, 
            hunks 
        });
    }
    
    return fileChanges;
}

// Helper function to apply a patch to content
function applyPatchToContent(originalContent: string, change: FileChange): string {
    let lines = originalContent.split('\n');
    
    // Apply hunks in reverse order (from bottom to top) to avoid line number shifts
    const sortedHunks = [...change.hunks].sort((a, b) => b.oldStartLine - a.oldStartLine); 
    
    for (const hunk of sortedHunks) {
        const { oldStartLine, oldLineCount, content } = hunk;
        
        const hunkLines = content.split('\n');
        const linesToInsert: string[] = [];

        for (const hunkLine of hunkLines) {
            if (hunkLine.startsWith('+')) {
                linesToInsert.push(hunkLine.substring(1)); // Add new line
            } else if (hunkLine.startsWith('-') || hunkLine.startsWith('\\')) {
                // This line is deleted from the original, so we don't add it to linesToInsert
            } else { // Context line (starts with ' ')
                linesToInsert.push(hunkLine.substring(1)); // Keep context line
            }
        }

        // The splice operation should remove 'oldLineCount' lines from the original content
        // starting at 'oldStartLine - 1' and insert 'linesToInsert'.
        lines.splice(oldStartLine - 1, oldLineCount, ...linesToInsert);
    }
    
    return lines.join('\n');
}

export function deactivate() {}
