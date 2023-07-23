/* AUTHOR NOTES
 *
 * Debug Adapter Protocol:
 *
 * DAP is not supported by coc-nvim like it's on VSCode. Because of that,
 * this extension code lacks the parts of the official VSCode extension code
 * related to DAP, however, some configuration options related to DAP are
 * still present, but are basically NOP for coc-nvim. These will be marked
 * with a comment containing 'DAP-SUPPORT'.
 *
 * You might ask why to keep DAP code partially ported? We want to keep the
 * ability for a user to use the VSCode configuration file as-is, thus we
 * need to keep track of some variables (even though NOP on coc-nvim) so no
 * errors are thrown at runtime. We could keep track of DAP-related vars and
 * ignore/remove them at runtime, but keep the code similar to the original
 * extension prevent us, maintainer, from pulling my hear some times.
 *
 * Bruno Meneguele <bmeneg@heredoc.io> 2023
 */

'use strict';
import 'core-js/stable';
import 'regenerator-runtime/runtime';
import * as net from 'net';
import {
  window,
  workspace,
  ExtensionContext,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  RevealOutputChannelOn,
} from 'coc.nvim';

/* The IPerlConfig interface doesn't contain all configuration options
 * because just some of them are necessary for Perl interpreter before the
 * actual langague server startup. The remainer of the options are kept
 * and used by coc.nvim through the package.json file */
interface IPerlConfig {
  enable: boolean;

  perlCmd: string;
  perlArgs: string[];
  perlInc: string[];

  // eslint-disable-next-line
  env: any;
  disablePassEnv: boolean;

  logFile: string;
  logLevel: number;

  // DAP-SUPPORT
  debugAdapterPort: number;
  debugAdapterPortRange: number;

  sshCmd: string;
  sshArgs: string[];
  sshUser: string;
  sshAddr: string;
  sshPort: number;

  containerCmd: string;
  containerArgs: string[];
  containerName: string;
  containerMode: string;
}

function getConfig(): IPerlConfig {
  return workspace.getConfiguration().get('perl') as IPerlConfig;
}

// DAP-SUPPORT
function checkPort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);

    server.listen({ host: '127.0.0.1', port: port }, () => {
      server.close(() => {
        resolve(port);
      });
    });
  });
}

// DAP-SUPPORT
async function getAvailablePort(
  port: number,
  port_range: number
): Promise<number> {
  for (let i = 0; i < port_range; i++) {
    try {
      console.log('try if port ' + (port + i) + ' is available');
      return await checkPort(port + i);
    } catch (error: unknown) {
      const errorCode = error as NodeJS.ErrnoException;
      if (errorCode.code === undefined) {
        throw error;
      } else {
        if (
          !['EADDRNOTAVAIL', 'EINVAL', 'EADDRINUSE'].includes(errorCode.code)
        ) {
          throw error;
        }
      }
    }
  }

  return port;
}

function resolveWorkspaceFolder(path: string, resource?: string): string {
  if (path.includes('${workspaceFolder}')) {
    const ws =
      workspace.getWorkspaceFolder(resource as string) ??
      workspace.workspaceFolders?.[0];
    const sub = ws?.uri ?? '';
    return path.replace('${workspaceFolder}', sub);
  }
  return path;
}

function buildContainerArgs(
  containerCmd: string,
  containerArgs: string[],
  containerName: string,
  containerMode: string
): string[] {
  if (containerMode != 'exec') containerMode = 'run';

  if (containerCmd) {
    if (containerArgs.length == 0) {
      if (containerCmd == 'docker') {
        containerArgs.push(containerMode);
        if (containerMode == 'run') containerArgs.push('--rm');
        containerArgs.push('-i', containerName);
      } else if (containerCmd == 'podman') {
        containerArgs.push(containerMode);
        if (containerMode == 'run') containerArgs.push('--rm');
        containerArgs.push('-i', containerName);
      } else if (containerCmd == 'docker-compose') {
        containerArgs.push(containerMode);
        if (containerMode == 'run') containerArgs.push('--rm');
        containerArgs.push('--no-deps', '-T', containerName);
      } else if (containerCmd == 'kubectl') {
        containerArgs.push('exec', containerName, '-i', '--');
      } else if (containerCmd == 'devspace') {
        containerArgs.push('--silent ', 'enter');
        if (containerName) containerArgs.push('-c', containerName);
        containerArgs.push('--');
      }
    }
  }

  return containerArgs;
}

export async function activate(context: ExtensionContext) {
  const config = getConfig();
  if (!config.enable) {
    console.log('extension for Perl disabled');
    return;
  }
  console.log('extension "perl" is now active');

  const lsVersion = '2.6.0';
  const resource = window.activeTextEditor?.document.uri;
  const perlIncOpt = config.perlInc.map((incDir: string): string => {
    return '-I' + resolveWorkspaceFolder(incDir, resource);
  });
  const perlCmd = resolveWorkspaceFolder(config.perlCmd, resource);
  const perlArgsOpt: string[] = [
    ...perlIncOpt,
    ...config.perlArgs,
    '-MPerl::LanguageServer',
    '-e',
    'Perl::LanguageServer::run',
    '--',
    '--log-level',
    config.logLevel.toString(),
    '--log-file',
    config.logFile,
    '--version',
    lsVersion,
  ];

  // DAP-SUPPORT
  let debugAdapterPort = config.debugAdapterPort;
  if (!config.containerCmd) {
    debugAdapterPort = await getAvailablePort(
      config.debugAdapterPort,
      config.debugAdapterPortRange
    );
    console.log('use ' + debugAdapterPort + ' as debug adapter port');
    perlArgsOpt.push('--port', debugAdapterPort.toString());
  }

  // eslint-disable-next-line
  let env: any = {}
  if (!config.disablePassEnv) {
    for (const k in process.env) {
      env[k] = process.env[k];
    }
  }
  if (Object.keys(config.env).length > 0) {
    for (const k in config.env) {
      env[k] = config.env[k];
    }
  }
  if (Object.keys(env).length > 0) {
    for (const k in env) {
      console.log('env: ' + k + ' = ' + env[k]);
    }
  }

  let sshCmd = config.sshCmd;
  let sshPortOpt = '-p';
  if (/^win/.test(process.platform)) {
    sshCmd = 'plink';
    sshPortOpt = '-P';
  }

  const containerArgsOpt: string[] = buildContainerArgs(
    config.containerCmd,
    config.containerArgs,
    config.containerName,
    config.containerMode
  );

  let serverCmd: string;
  let serverArgs: string[] = [];
  if (config.sshAddr && config.sshUser) {
    serverCmd = sshCmd;
    if (config.sshPort) {
      serverArgs.push(sshPortOpt, config.sshPort.toString());
    }
    serverArgs.push(
      '-l',
      config.sshUser,
      config.sshAddr,
      '-L',
      config.debugAdapterPort + ':127.0.0.1:' + config.debugAdapterPort // DAP-SUPPORT
    );
    if (config.containerCmd) {
      serverArgs.push(config.containerCmd);
      serverArgs = serverArgs.concat(containerArgsOpt);
    }
    serverArgs = serverArgs.concat(perlCmd, perlArgsOpt);
  } else {
    if (config.containerCmd) {
      serverCmd = config.containerCmd;
      serverArgs = containerArgsOpt.concat(perlCmd, perlArgsOpt);
    } else {
      serverCmd = perlCmd;
      serverArgs = perlArgsOpt;
    }
  }
  console.log('cmd: ' + serverCmd + ' args: ' + serverArgs.join(' '));

  const serverOptions: ServerOptions = {
    run: {
      command: serverCmd,
      args: serverArgs,
      options: { env: env },
    },
    debug: {
      command: serverCmd,
      args: serverArgs.concat(['--debug']),
      options: { env: env },
    },
  };

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    // Register the server for plain text documents
    documentSelector: [{ scheme: 'file', language: 'perl' }],
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    synchronize: {
      // Synchronize the setting section 'perl_lang' to the server
      configurationSection: 'perl',
    },
  };

  // Create the language client and start the client.
  const client = new LanguageClient(
    'perl',
    'Perl Language Server',
    serverOptions,
    clientOptions
  ).start();

  // Push the disposable to the context's subscriptions so that the
  // client can be deactivated on extension deactivation
  context.subscriptions.push(client);
}
