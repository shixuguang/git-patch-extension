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
            
            // 4. For each file change, show diff and prompt for confirmation
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
                
                // Handle deleted files
                if (change.isDeleted) {
                    if (targetFileExists) {
                        const deleteFile = await vscode.window.showInformationMessage(
                            `Delete file ${change.filePath}?`,
                            'Yes', 'No'
                        );
                        
                        if (deleteFile === 'Yes') {
                            fs.unlinkSync(targetFilePath);
                            vscode.window.showInformationMessage(`Deleted ${change.filePath}`);
                        }
                    }
                    continue;
                }
                
                // Create temporary file with the changes applied
                const tempFilePath = path.join(workspaceRoot, `.temp_${path.basename(change.filePath)}`);
                
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
                
                // Ensure temp directory exists
                const tempDir = path.dirname(tempFilePath);
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }
                
                try {
                    fs.writeFileSync(tempFilePath, newContent);
                } catch (error) {
                    vscode.window.showErrorMessage(`Error creating temp file for ${change.filePath}: ${error instanceof Error ? error.message : String(error)}`);
                    continue;
                }
                
                // 5. Show diff using VS Code's diff editor
                const originalUri = targetFileExists 
                    ? vscode.Uri.file(targetFilePath)
                    : vscode.Uri.file(tempFilePath).with({ scheme: 'untitled' });
                const modifiedUri = vscode.Uri.file(tempFilePath);
                
                const title = `${change.filePath} (Git Patch Preview)`;
                
                try {
                    await vscode.commands.executeCommand('vscode.diff', 
                        originalUri, 
                        modifiedUri,
                        title
                    );
                } catch (error) {
                    vscode.window.showErrorMessage(`Error showing diff for ${change.filePath}: ${error instanceof Error ? error.message : String(error)}`);
                    continue;
                }
                
                // 6. Prompt user to apply this change
                const applyChange = await vscode.window.showInformationMessage(
                    `Apply changes to ${change.filePath}?`,
                    'Yes', 'No'
                );
                
                if (applyChange === 'Yes') {
                    try {
                        // Create directory if it doesn't exist (for new files)
                        const targetDir = path.dirname(targetFilePath);
                        if (!fs.existsSync(targetDir)) {
                            fs.mkdirSync(targetDir, { recursive: true });
                        }
                        
                        // Apply changes
                        fs.writeFileSync(targetFilePath, newContent);
                        vscode.window.showInformationMessage(`Changes applied to ${change.filePath}`);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Error applying changes to ${change.filePath}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
                
                // Clean up temporary file
                try {
                    if (fs.existsSync(tempFilePath)) {
                        fs.unlinkSync(tempFilePath);
                    }
                } catch (error) {
                    console.log(`Error cleaning up temp file: ${error instanceof Error ? error.message : String(error)}`);
                }
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
        startLine: number;
        lineCount: number;
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
        let currentHunk = { startLine: 0, lineCount: 0, content: '' };
        let hunkHeaderMatch: RegExpMatchArray | null = null;
        
        for (let j = 1; j < lines.length; j++) {
            const line = lines[j];
            
            if (line.startsWith('@@')) {
                // Start of a new hunk
                if (inHunk) {
                    hunks.push({ ...currentHunk });
                }
                
                // Support both formats:
                // @@ -1,3 +1,4 @@ (showing line count)
                // @@ -1 +1 @@ (single line, no comma)
                hunkHeaderMatch = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
                if (hunkHeaderMatch) {
                    inHunk = true;
                    const startLine = parseInt(hunkHeaderMatch[3], 10);
                    const lineCount = hunkHeaderMatch[4] ? parseInt(hunkHeaderMatch[4], 10) : 1;
                    
                    currentHunk = {
                        startLine,
                        lineCount,
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
    const sortedHunks = [...change.hunks].sort((a, b) => b.startLine - a.startLine);
    
    for (const hunk of sortedHunks) {
        const { startLine, content } = hunk;
        
        // Parse the hunk content to get actual changes
        const hunkLines = content.split('\n');
        const newLines = hunkLines
            .filter(line => !line.startsWith('-') && !line.startsWith('\\'))
            .map(line => line.startsWith('+') ? line.substring(1) : line);
        
        // Replace lines in original content
        const before = lines.slice(0, startLine - 1);
        const after = lines.slice(startLine - 1 + hunkLines.filter(line => !line.startsWith('+')).length);
        
        lines = [...before, ...newLines, ...after];
    }
    
    return lines.join('\n');
}

export function deactivate() {}
