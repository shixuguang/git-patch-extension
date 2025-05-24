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
            
            // 6. If user wants to preview, show diffs for all files
            if (applyPatch === 'Preview Changes') {
                for (const item of supportedChanges) {
                    const targetFileExists = fs.existsSync(item.targetFilePath);
                    const originalUri = targetFileExists 
                        ? vscode.Uri.file(item.targetFilePath)
                        : vscode.Uri.file(item.tempFilePath).with({ scheme: 'untitled' });
                    const modifiedUri = vscode.Uri.file(item.tempFilePath);
                    
                    const title = `${item.change.filePath} (Git Patch Preview)`;
                    
                    try {
                        await vscode.commands.executeCommand('vscode.diff', 
                            originalUri, 
                            modifiedUri,
                            title,
                            { preview: false, viewColumn: vscode.ViewColumn.Beside } // Open in a new column and keep it
                        );
                    } catch (error) {
                        vscode.window.showErrorMessage(`Error showing diff for ${item.change.filePath}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
                
                // Ask again after preview
                const applyAfterPreview = await vscode.window.showInformationMessage(
                    `Apply patch to ${totalFiles} file(s)?`,
                    'Yes', 'No'
                );
                
                if (applyAfterPreview !== 'Yes') {
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
        
        const sourceFilePath = filePathMatch[1];
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
