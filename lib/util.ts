/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, SpawnOptions, spawn } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as createHttpProxyAgent from 'http-proxy-agent';
import * as https from 'https';
import * as createHttpsProxyAgent from 'https-proxy-agent';
import * as path from 'path';
import { URL } from 'url';
import { DownloadOptions, DownloadPlatform, downloadAndUnzipVSCode } from './download';
import * as request from './request';
import { TestOptions, getProfileArguments } from './runTest';

export let systemDefaultPlatform: DownloadPlatform;

const windowsPlatforms = new Set<DownloadPlatform>(['win32-x64-archive', 'win32-arm64-archive']);
const darwinPlatforms = new Set<DownloadPlatform>(['darwin-arm64', 'darwin']);

switch (process.platform) {
	case 'darwin':
		systemDefaultPlatform = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin';
		break;
	case 'win32':
		systemDefaultPlatform = process.arch === 'arm64' ? 'win32-arm64-archive' : 'win32-x64-archive';
		break;
	default:
		systemDefaultPlatform =
			process.arch === 'arm64' ? 'linux-arm64' : process.arch === 'arm' ? 'linux-armhf' : 'linux-x64';
}

const UNRELEASED_SUFFIX = '-unreleased';

export class Version {
	public static parse(version: string): Version {
		const unreleased = version.endsWith(UNRELEASED_SUFFIX);
		if (unreleased) {
			version = version.slice(0, -UNRELEASED_SUFFIX.length);
		}

		return new Version(version, !unreleased);
	}

	constructor(public readonly id: string, public readonly isReleased = true) {}

	public get isCommit() {
		return /^[0-9a-f]{40}$/.test(this.id);
	}

	public get isInsiders() {
		return this.id === 'insiders' || this.id.endsWith('-insider');
	}

	public get isStable() {
		return this.id === 'stable' || /^[0-9]+\.[0-9]+\.[0-9]$/.test(this.id);
	}

	public toString() {
		return this.id + (this.isReleased ? '' : UNRELEASED_SUFFIX);
	}
}

export function getVSCodeDownloadUrl(version: Version, platform: string) {
	if (version.id === 'insiders') {
		return `https://update.code.visualstudio.com/latest/${platform}/insider?released=${version.isReleased}`;
	} else if (version.isInsiders) {
		return `https://update.code.visualstudio.com/${version.id}/${platform}/insider?released=${version.isReleased}`;
	} else if (version.isStable) {
		return `https://update.code.visualstudio.com/${version.id}/${platform}/stable?released=${version.isReleased}`;
	} else {
		// insiders commit hash
		return `https://update.code.visualstudio.com/commit:${version.id}/${platform}/insider`;
	}
}

let PROXY_AGENT: createHttpProxyAgent.HttpProxyAgent | undefined = undefined;
let HTTPS_PROXY_AGENT: createHttpsProxyAgent.HttpsProxyAgent | undefined = undefined;

if (process.env.npm_config_proxy) {
	PROXY_AGENT = createHttpProxyAgent(process.env.npm_config_proxy);
	HTTPS_PROXY_AGENT = createHttpsProxyAgent(process.env.npm_config_proxy);
}
if (process.env.npm_config_https_proxy) {
	HTTPS_PROXY_AGENT = createHttpsProxyAgent(process.env.npm_config_https_proxy);
}

export function urlToOptions(url: string): https.RequestOptions {
	const parsed = new URL(url);
	const options: https.RequestOptions = {};
	if (PROXY_AGENT && parsed.protocol.startsWith('http:')) {
		options.agent = PROXY_AGENT;
	}

	if (HTTPS_PROXY_AGENT && parsed.protocol.startsWith('https:')) {
		options.agent = HTTPS_PROXY_AGENT;
	}

	return options;
}

export function downloadDirToExecutablePath(dir: string, platform: DownloadPlatform) {
	if (windowsPlatforms.has(platform)) {
		return path.resolve(dir, 'Code.exe');
	} else if (darwinPlatforms.has(platform)) {
		return path.resolve(dir, 'Visual Studio Code.app/Contents/MacOS/Electron');
	} else {
		return path.resolve(dir, 'code');
	}
}

export function insidersDownloadDirToExecutablePath(dir: string, platform: DownloadPlatform) {
	if (windowsPlatforms.has(platform)) {
		return path.resolve(dir, 'Code - Insiders.exe');
	} else if (darwinPlatforms.has(platform)) {
		return path.resolve(dir, 'Visual Studio Code - Insiders.app/Contents/MacOS/Electron');
	} else {
		return path.resolve(dir, 'code-insiders');
	}
}

export function insidersDownloadDirMetadata(dir: string, platform: DownloadPlatform) {
	let productJsonPath;
	if (windowsPlatforms.has(platform)) {
		productJsonPath = path.resolve(dir, 'resources/app/product.json');
	} else if (darwinPlatforms.has(platform)) {
		productJsonPath = path.resolve(dir, 'Visual Studio Code - Insiders.app/Contents/Resources/app/product.json');
	} else {
		productJsonPath = path.resolve(dir, 'resources/app/product.json');
	}
	const productJson = JSON.parse(readFileSync(productJsonPath, 'utf-8'));

	return {
		version: productJson.commit,
		date: new Date(productJson.date),
	};
}

export interface IUpdateMetadata {
	url: string;
	name: string;
	version: string;
	productVersion: string;
	hash: string;
	timestamp: number;
	sha256hash: string;
	supportsFastUpdate: boolean;
}

export async function getInsidersVersionMetadata(platform: string, version: string, released: boolean) {
	const remoteUrl = `https://update.code.visualstudio.com/api/versions/${version}/${platform}/insider?released=${released}`;
	return await request.getJSON<IUpdateMetadata>(remoteUrl, 30_000);
}

export async function getLatestInsidersMetadata(platform: string, released: boolean) {
	const remoteUrl = `https://update.code.visualstudio.com/api/update/${platform}/insider/latest?released=${released}`;
	return await request.getJSON<IUpdateMetadata>(remoteUrl, 30_000);
}

/**
 * Resolve the VS Code cli path from executable path returned from `downloadAndUnzipVSCode`.
 * Usually you will want {@link resolveCliArgsFromVSCodeExecutablePath} instead.
 */
export function resolveCliPathFromVSCodeExecutablePath(
	vscodeExecutablePath: string,
	platform: DownloadPlatform = systemDefaultPlatform
) {
	if (platform === 'win32-archive') {
		throw new Error('Windows 32-bit is no longer supported');
	}
	if (windowsPlatforms.has(platform)) {
		if (vscodeExecutablePath.endsWith('Code - Insiders.exe')) {
			return path.resolve(vscodeExecutablePath, '../bin/code-insiders.cmd');
		} else {
			return path.resolve(vscodeExecutablePath, '../bin/code.cmd');
		}
	} else if (darwinPlatforms.has(platform)) {
		return path.resolve(vscodeExecutablePath, '../../../Contents/Resources/app/bin/code');
	} else {
		if (vscodeExecutablePath.endsWith('code-insiders')) {
			return path.resolve(vscodeExecutablePath, '../bin/code-insiders');
		} else {
			return path.resolve(vscodeExecutablePath, '../bin/code');
		}
	}
}
/**
 * Resolve the VS Code cli arguments from executable path returned from `downloadAndUnzipVSCode`.
 * You can use this path to spawn processes for extension management. For example:
 *
 * ```ts
 * const cp = require('child_process');
 * const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron')
 * const vscodeExecutablePath = await downloadAndUnzipVSCode('1.36.0');
 * const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
 *
 * cp.spawnSync(cli, [...args, '--install-extension', '<EXTENSION-ID-OR-PATH-TO-VSIX>'], {
 *   encoding: 'utf-8',
 *   stdio: 'inherit'
 *   shell: process.platform === 'win32',
 * });
 * ```
 *
 * @param vscodeExecutablePath The `vscodeExecutablePath` from `downloadAndUnzipVSCode`.
 */
export function resolveCliArgsFromVSCodeExecutablePath(
	vscodeExecutablePath: string,
	options?: Pick<TestOptions, 'reuseMachineInstall' | 'platform'>
) {
	const args = [
		resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath, options?.platform ?? systemDefaultPlatform),
	];
	if (!options?.reuseMachineInstall) {
		args.push(...getProfileArguments(args));
	}

	return args;
}

export type RunVSCodeCommandOptions = Partial<DownloadOptions> & { spawn?: SpawnOptions };

export class VSCodeCommandError extends Error {
	constructor(
		args: string[],
		public readonly exitCode: number | null,
		public readonly stderr: string,
		public stdout: string
	) {
		super(`'code ${args.join(' ')}' failed with exit code ${exitCode}:\n\n${stderr}\n\n${stdout}`);
	}
}

/**
 * Runs a VS Code command, and returns its output
 * @throws a {@link VSCodeCommandError} if the command fails
 */
export async function runVSCodeCommand(args: string[], options: RunVSCodeCommandOptions = {}) {
	const vscodeExecutablePath = await downloadAndUnzipVSCode(options);
	const [cli, ...baseArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

	const shell = process.platform === 'win32';

	return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		let stdout = '';
		let stderr = '';

		const child = spawn(shell ? `"${cli}"` : cli, [...baseArgs, ...args], {
			stdio: 'pipe',
			shell,
			windowsHide: true,
			...options.spawn,
		});

		child.stdout?.setEncoding('utf-8').on('data', (data) => (stdout += data));
		child.stderr?.setEncoding('utf-8').on('data', (data) => (stderr += data));

		child.on('error', reject);
		child.on('exit', (code) => {
			if (code !== 0) {
				reject(new VSCodeCommandError(args, code, stderr, stdout));
			} else {
				resolve({ stdout, stderr });
			}
		});
	});
}

/** Predicates whether arg is undefined or null */
export function isDefined<T>(arg: T | undefined | null): arg is T {
	return arg != null;
}

/**
 * Validates the stream data matches the given length and checksum, if any.
 *
 * Note: md5 is not ideal, but it's what we get from the CDN, and for the
 * purposes of self-reported content verification is sufficient.
 */
export function validateStream(readable: NodeJS.ReadableStream, length: number, sha256?: string) {
	let actualLen = 0;
	const checksum = sha256 ? createHash('sha256') : undefined;
	return new Promise<void>((resolve, reject) => {
		readable.on('data', (chunk) => {
			checksum?.update(chunk);
			actualLen += chunk.length;
		});
		readable.on('error', reject);
		readable.on('end', () => {
			if (actualLen !== length) {
				return reject(new Error(`Downloaded stream length ${actualLen} does not match expected length ${length}`));
			}

			const digest = checksum?.digest('hex');
			if (digest && digest !== sha256) {
				return reject(new Error(`Downloaded file checksum ${digest} does not match expected checksum ${sha256}`));
			}

			resolve();
		});
	});
}

/** Gets a Buffer from a Node.js stream */
export function streamToBuffer(readable: NodeJS.ReadableStream) {
	return new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		readable.on('data', (chunk) => chunks.push(chunk));
		readable.on('error', reject);
		readable.on('end', () => resolve(Buffer.concat(chunks)));
	});
}
/** Gets whether child is a subdirectory of the parent */
export function isSubdirectory(parent: string, child: string) {
	const relative = path.relative(parent, child);
	return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Wraps a function so that it's called once, and never again, memoizing
 * the result unless it rejects.
 */
export function onceWithoutRejections<T, Args extends unknown[]>(fn: (...args: Args) => Promise<T>) {
	let value: Promise<T> | undefined;
	return (...args: Args) => {
		if (!value) {
			value = fn(...args).catch((err) => {
				value = undefined;
				throw err;
			});
		}

		return value;
	};
}

export function killTree(processId: number, force: boolean) {
	let cp: ChildProcess;

	if (process.platform === 'win32') {
		const windir = process.env['WINDIR'] || 'C:\\Windows';

		// when killing a process in Windows its child processes are *not* killed but become root processes.
		// Therefore we use TASKKILL.EXE
		cp = spawn(
			path.join(windir, 'System32', 'taskkill.exe'),
			[...(force ? ['/F'] : []), '/T', '/PID', processId.toString()],
			{ stdio: 'inherit' }
		);
	} else {
		// on linux and OS X we kill all direct and indirect child processes as well
		cp = spawn('sh', [path.resolve(__dirname, '../killTree.sh'), processId.toString(), force ? '9' : '15'], {
			stdio: 'inherit',
		});
	}

	return new Promise<void>((resolve, reject) => {
		cp.on('error', reject).on('exit', resolve);
	});
}
