/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BUILD_OUTPUT_DIRS, SKIP_DIRS } from './logic.js';
import type { DotnetProject } from './extension.js';

export type TreeNode = SolutionNode | ProjectNode | FolderNode | FileNode;

interface ListContext {
	hideBuildOutput: boolean;
	/** Directories of the other detected projects — nested project roots are excluded
	 *  from a parent project's file listing so projects never appear twice. */
	excludeDirs: string[];
	excludeFiles: string[];
}

export class SolutionNode extends vscode.TreeItem {
	readonly kind = 'solution' as const;
	readonly fsPath: string;
	constructor(solutionPath: string, readonly projects: DotnetProject[], private readonly isStartup: (project: DotnetProject) => boolean) {
		super(path.basename(solutionPath), vscode.TreeItemCollapsibleState.Expanded);
		this.fsPath = solutionPath;
		this.resourceUri = vscode.Uri.file(solutionPath);
		this.contextValue = 'solution';
		this.iconPath = new vscode.ThemeIcon('file-directory');
		this.tooltip = `Active solution: ${solutionPath}`;
	}
	children(): TreeNode[] {
		return this.projects.map(p => new ProjectNode(p, this.isStartup(p)));
	}
}

export class ProjectNode extends vscode.TreeItem {
	readonly kind = 'project' as const;
	readonly fsPath: string;
	constructor(readonly project: DotnetProject, isStartup: boolean) {
		// The Startup Project is emphasized (highlighted label) like Rider's bold entry.
		super(
			isStartup
				? { label: project.name, highlights: [[0, project.name.length]] }
				: project.name,
			vscode.TreeItemCollapsibleState.Expanded,
		);
		this.fsPath = project.csproj;
		this.description = isStartup ? 'Startup Project' : (project.kind === 'WEB' ? 'Web Project' : 'Console Project');
		this.iconPath = new vscode.ThemeIcon('project');
		this.contextValue = isStartup ? 'project-startup' : 'project';
		this.resourceUri = vscode.Uri.file(project.csproj);
	}
}

export class FolderNode extends vscode.TreeItem {
	readonly kind = 'folder' as const;
	constructor(readonly dir: string, private readonly ctx: ListContext) {
		super(path.basename(dir), vscode.TreeItemCollapsibleState.Collapsed);
		this.resourceUri = vscode.Uri.file(dir);
		this.contextValue = 'folder';
		this.iconPath = vscode.ThemeIcon.Folder;
	}
	children(): TreeNode[] {
		return listFiles(this.dir, this.ctx);
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

function listContext(hideBuildOutput: boolean, projects: DotnetProject[], excludeProject?: DotnetProject): ListContext {
	const others = projects.filter(p => !excludeProject || p.csproj !== excludeProject.csproj);
	return {
		hideBuildOutput,
		excludeDirs: others.map(p => p.dir),
		excludeFiles: others.map(p => p.csproj),
	};
}

function listFiles(dir: string, ctx: ListContext): TreeNode[] {
	const skip = new Set(SKIP_DIRS);
	if (ctx.hideBuildOutput) {
		for (const d of BUILD_OUTPUT_DIRS) {
			skip.add(d);
		}
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
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (skip.has(entry.name) || ctx.excludeDirs.includes(full)) {
				continue; // another project's root: it has its own project node
			}
			folders.push(new FolderNode(full, ctx));
		} else if (entry.isFile() && !ctx.excludeFiles.includes(full)) {
			files.push(new FileNode(full));
		}
	}
	folders.sort((a, b) => a.label!.toString().localeCompare(b.label!.toString()));
	files.sort((a, b) => a.label!.toString().localeCompare(b.label!.toString()));
	return [...folders, ...files];
}

export class SolutionExplorerProvider implements vscode.TreeDataProvider<TreeNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	/** Cached detection result: file churn refreshes the tree without re-scanning;
	 *  csproj/sln churn invalidates the cache (redetect). */
	private cache: { projects: DotnetProject[]; solution: string | undefined } | undefined;

	constructor(
		private readonly getProjects: () => Promise<{ projects: DotnetProject[]; solution: string | undefined }>,
		private readonly isStartup: (project: DotnetProject) => boolean,
	) { }

	refresh(options?: { redetect?: boolean }): void {
		if (options?.redetect) {
			this.cache = undefined;
		}
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!element) {
			this.cache ??= await this.getProjects();
			const { projects, solution } = this.cache;
			await vscode.commands.executeCommand('setContext', 'dotnet.hasProjects', projects.length > 0);
			await vscode.commands.executeCommand('setContext', 'dotnet.hasSolution', !!solution);
			if (solution) {
				return [new SolutionNode(solution, projects, this.isStartup)];
			}
			// Standalone projects (no solution): shown as top-level nodes so the tree
			// always mirrors what Run/Debug will use.
			return projects.map(p => new ProjectNode(p, this.isStartup(p)));
		}
		if (element instanceof SolutionNode) {
			return element.children();
		}
		if (element instanceof ProjectNode) {
			const hideBuildOutput = vscode.workspace.getConfiguration('dotnet')
				.get<boolean>('solutionExplorer.hideBuildOutput', true);
			const ctx = listContext(hideBuildOutput, this.cache?.projects ?? [], element.project);
			return listFiles(element.project.dir, { ...ctx, excludeFiles: [...ctx.excludeFiles, element.project.csproj] });
		}
		if (element instanceof FolderNode) {
			return element.children();
		}
		return [];
	}
}
