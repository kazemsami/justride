/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { DotnetProject } from './extension.js';
import { isRunnableKind } from './logic.js';

export type TreeNode = SolutionNode | ProjectNode | FolderNode | FileNode;

export class SolutionNode extends vscode.TreeItem {
	readonly kind = 'solution' as const;
	readonly fsPath: string;
	constructor(solutionPath: string, private readonly projects: DotnetProject[], private readonly isStartup: (project: DotnetProject) => boolean) {
		super(path.basename(solutionPath), vscode.TreeItemCollapsibleState.Expanded);
		this.fsPath = solutionPath;
		this.resourceUri = vscode.Uri.file(solutionPath);
		this.contextValue = 'solution';
		this.iconPath = new vscode.ThemeIcon('file-directory');
		this.tooltip = `Active solution: ${solutionPath}`;
	}
	async children(): Promise<TreeNode[]> {
		return this.projects.map(p => new ProjectNode(p, this.isStartup(p)));
	}
}

export class ProjectNode extends vscode.TreeItem {
	readonly kind = 'project' as const;
	readonly fsPath: string;
	constructor(readonly project: DotnetProject, isStartup: boolean) {
		super(project.name, vscode.TreeItemCollapsibleState.Expanded);
		this.fsPath = project.csproj;
		this.description = isStartup ? 'Startup Project' : (project.kind === 'WEB' ? 'Web Project' : 'Console Project');
		this.iconPath = new vscode.ThemeIcon('project');
		this.contextValue = isStartup ? 'project-startup' : 'project';
		this.resourceUri = vscode.Uri.file(project.csproj);
	}
	async children(): Promise<TreeNode[]> {
		return listFiles(this.project.dir, this.project.csproj);
	}
}

export class FolderNode extends vscode.TreeItem {
	readonly kind = 'folder' as const;
	constructor(readonly dir: string) {
		super(path.basename(dir), vscode.TreeItemCollapsibleState.Collapsed);
		this.resourceUri = vscode.Uri.file(dir);
		this.contextValue = 'folder';
		this.iconPath = vscode.ThemeIcon.Folder;
	}
	async children(): Promise<TreeNode[]> {
		return listFiles(this.dir);
	}
}

export class FileNode extends vscode.TreeItem {
	readonly kind = 'file' as const;
	readonly fsPath: string;
	constructor(file: string) {
		super(path.basename(file));
		this.fsPath = file;
		this.resourceUri = vscode.Uri.file(file);
		this.contextValue = 'file';
		this.iconPath = vscode.ThemeIcon.File;
		this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(file)] };
	}
}

const SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', '.git', '.vs']);

async function listFiles(dir: string, csproj?: string): Promise<TreeNode[]> {
	const hideBuildOutput = vscode.workspace.getConfiguration('dotnet').get<boolean>('solutionExplorer.hideBuildOutput', true);
	const skip = new Set(SKIP_DIRS);
	if (hideBuildOutput) {
		skip.add('bin');
		skip.add('obj');
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const folders: TreeNode[] = [];
	const files: TreeNode[] = [];
	for (const entry of entries) {
		if (skip.has(entry.name)) {
			continue;
		}
		const full = path.join(dir, entry.name);
		if (csproj && path.join(dir, entry.name) === csproj) {
			continue; // the project node itself already represents the .csproj
		}
		if (entry.isDirectory()) {
			folders.push(new FolderNode(full));
		} else if (entry.isFile()) {
			files.push(new FileNode(full));
		}
	}
	folders.sort((a, b) => a.label!.toString().localeCompare(b.label!.toString()));
	files.sort((a, b) => a.label!.toString().localeCompare(b.label!.toString()));
	return [...folders, ...files];
}

export class SolutionExplorerProvider implements vscode.TreeDataProvider<TreeNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		private readonly getProjects: () => Promise<{ projects: DotnetProject[]; solution: string | undefined }>,
		private readonly isStartup: (project: DotnetProject) => boolean,
	) { }

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!element) {
			const { projects, solution } = await this.getProjects();
			await vscode.commands.executeCommand('setContext', 'dotnet.hasProjects', projects.length > 0);
			await vscode.commands.executeCommand('setContext', 'dotnet.hasSolution', !!solution);
			if (solution) {
				return [new SolutionNode(solution, projects, this.isStartup)];
			}
			// Standalone projects (no solution): shown as top-level nodes so the tree
			// always mirrors what Run/Debug will use.
			return projects.map(p => new ProjectNode(p, this.isStartup(p)));
		}
		if (element.kind === 'solution' || element.kind === 'project' || element.kind === 'folder') {
			return element.children();
		}
		return [];
	}
}

/** Runnable check used by menus: Library Projects cannot be started. */
export function isRunnableProject(project: DotnetProject): boolean {
	return isRunnableKind(project.kind);
}
