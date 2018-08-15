/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as platform from 'vs/base/common/platform';
import * as pty from 'node-pty';
import { Event, Emitter } from 'vs/base/common/event';
import { ITerminalChildProcess } from 'vs/workbench/parts/terminal/node/terminal';
import { IDisposable } from 'vs/base/common/lifecycle';
import { IShellLaunchConfig } from 'vs/workbench/parts/terminal/common/terminal';

export class TerminalProcess implements ITerminalChildProcess, IDisposable {
	private _exitCode: number;
	private _closeTimeout: number;
	private _ptyProcess: pty.IPty;
	private _currentTitle: string = '';

	private readonly _onProcessData: Emitter<string> = new Emitter<string>();
	public get onProcessData(): Event<string> { return this._onProcessData.event; }
	private readonly _onProcessExit: Emitter<number> = new Emitter<number>();
	public get onProcessExit(): Event<number> { return this._onProcessExit.event; }
	private readonly _onProcessIdReady: Emitter<number> = new Emitter<number>();
	public get onProcessIdReady(): Event<number> { return this._onProcessIdReady.event; }
	private readonly _onProcessTitleChanged: Emitter<string> = new Emitter<string>();
	public get onProcessTitleChanged(): Event<string> { return this._onProcessTitleChanged.event; }

	constructor(
		shellLaunchConfig: IShellLaunchConfig,
		cwd: string,
		cols: number,
		rows: number,
		env: platform.IProcessEnvironment
	) {
		let shellName: string;
		if (os.platform() === 'win32') {
			shellName = path.basename(shellLaunchConfig.executable);
		} else {
			// Using 'xterm-256color' here helps ensure that the majority of Linux distributions will use a
			// color prompt as defined in the default ~/.bashrc file.
			shellName = 'xterm-256color';
		}

		const options: pty.IPtyForkOptions = {
			name: shellName,
			cwd,
			env,
			cols,
			rows
		};

		this._ptyProcess = pty.spawn(shellLaunchConfig.executable, shellLaunchConfig.args, options);
		this._ptyProcess.on('data', (data) => {
			this._onProcessData.fire(data);
			if (this._closeTimeout) {
				clearTimeout(this._closeTimeout);
				this._queueProcessExit();
			}
		});
		this._ptyProcess.on('exit', (code) => {
			this._exitCode = code;
			this._queueProcessExit();
		});

		// TODO: We should no longer need to delay this since pty.spawn is sync
		setTimeout(() => {
			this._sendProcessId();
		}, 500);
		this._setupTitlePolling();
	}

	public dispose(): void {
		this._onProcessData.dispose();
		this._onProcessExit.dispose();
		this._onProcessIdReady.dispose();
		this._onProcessTitleChanged.dispose();
	}

	private _setupTitlePolling() {
		this._sendProcessTitle();
		setInterval(() => {
			if (this._currentTitle !== this._ptyProcess.process) {
				this._sendProcessTitle();
			}
		}, 200);
	}

	// Allow any trailing data events to be sent before the exit event is sent.
	// See https://github.com/Tyriar/node-pty/issues/72
	private _queueProcessExit() {
		if (this._closeTimeout) {
			clearTimeout(this._closeTimeout);
		}
		this._closeTimeout = setTimeout(() => {
			this._ptyProcess.kill();
			this._onProcessExit.fire(this._exitCode);
			this.dispose();
		}, 250);
	}

	private _sendProcessId() {
		this._onProcessIdReady.fire(this._ptyProcess.pid);
	}

	private _sendProcessTitle(): void {
		this._currentTitle = this._ptyProcess.process;
		this._onProcessTitleChanged.fire(this._currentTitle);
	}

	public shutdown(): void {
		this._queueProcessExit();
	}

	public input(data: string): void {
		this._ptyProcess.write(data);
	}

	public resize(cols: number, rows: number): void {
		// Ensure that cols and rows are always >= 1, this prevents a native
		// exception in winpty.
		this._ptyProcess.resize(Math.max(cols, 1), Math.max(rows, 1));
	}
}
