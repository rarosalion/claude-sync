/**
 * Interactive init wizard — sets up claude-sync on this device
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { detectEnvironment, suggestBackend } from '../core/detector.js';
import { DeviceRegistry } from '../core/device-registry.js';
import { writeFileAtomic } from '../core/atomic.js';
import { getBackend, ENCRYPTION_NOT_IMPLEMENTED } from './helpers.js';
import { CONFIG_DIR, CONFIG_FILE } from '../types.js';
import type { SyncConfig, BackendConfig, BackendType, CloudProvider } from '../types.js';

interface InitOptions {
  backend?: string;
  deviceName?: string;
  remoteUrl?: string;
  cloudProvider?: string;
  cloudPath?: string;
  rsyncTarget?: string;
  sshKey?: string;
  pushCmd?: string;
  pullCmd?: string;
  encrypt?: boolean;
  autoSync?: boolean;
  watch?: boolean;
}

export async function initCommand(options: InitOptions): Promise<void> {
  console.log('');
  console.log(chalk.cyan.bold('  claude-sync setup'));
  console.log(chalk.dim('  Sync your Claude Code memory across all your devices'));
  console.log('');

  // Detect environment
  const env = await detectEnvironment();
  const suggestions = suggestBackend(env);

  // Check if already initialized
  const configDir = path.join(os.homedir(), CONFIG_DIR);
  const configFile = path.join(configDir, CONFIG_FILE);
  let existingConfig = false;

  try {
    await fs.access(configFile);
    existingConfig = true;
  } catch {
    // Not initialized yet
  }

  if (existingConfig) {
    const { overwrite } = await inquirer.prompt([{
      type: 'confirm',
      name: 'overwrite',
      message: 'claude-sync is already configured on this device. Reconfigure?',
      default: false,
    }]);

    if (!overwrite) {
      console.log(chalk.dim('  Setup cancelled.'));
      return;
    }
  }

  // Check if .claude/ exists
  if (!(await pathExists(env.claudeDir))) {
    console.log(chalk.yellow('  Note: ~/.claude/ directory not found.'));
    console.log(chalk.dim('  It will be created when Claude Code runs for the first time.'));
    console.log('');
  }

  // ── Device Name ──────────────────────────────────────────────

  const { deviceName } = options.deviceName
    ? { deviceName: options.deviceName }
    : await inquirer.prompt([{
        type: 'input',
        name: 'deviceName',
        message: "What's this device's name?",
        default: os.hostname(),
      }]);

  // ── Backend Selection ────────────────────────────────────────

  let backendType: BackendType;

  if (options.backend) {
    backendType = options.backend as BackendType;
  } else {
    const backendChoices = [];

    if (suggestions.includes('git')) {
      backendChoices.push({
        name: `${chalk.green('Git')} ${chalk.dim('(recommended)')} — version history, works everywhere`,
        value: 'git',
      });
    }

    if (suggestions.includes('cloud')) {
      const providers = env.cloudStoragePaths.filter(c => c.exists).map(c => c.provider);
      backendChoices.push({
        name: `${chalk.blue('iCloud / Dropbox / OneDrive')} — just works ${chalk.dim(`(detected: ${providers.join(', ') || 'none'})`)}`,
        value: 'cloud',
      });
    }

    if (suggestions.includes('syncthing')) {
      backendChoices.push({
        name: `${chalk.magenta('Syncthing')} — P2P, maximum privacy`,
        value: 'syncthing',
      });
    }

    if (suggestions.includes('rsync')) {
      backendChoices.push({
        name: `${chalk.yellow('rsync over SSH')} — advanced, direct machine-to-machine`,
        value: 'rsync',
      });
    }

    backendChoices.push({
      name: `${chalk.cyan('Gitea')} ${chalk.dim('(self-hosted ★)')} — your own Git server, works on LAN/intranet`,
      value: 'gitea',
    });

    backendChoices.push({
      name: `${chalk.dim('Custom command')} — bring your own sync`,
      value: 'custom',
    });

    const answer = await inquirer.prompt([{
      type: 'list',
      name: 'backend',
      message: 'How do you want to sync?',
      choices: backendChoices,
    }]);

    backendType = answer.backend;
  }

  // ── Backend-specific Configuration ───────────────────────────

  const backendConfig: BackendConfig = { type: backendType };

  switch (backendType) {
    case 'git': {
      const { remoteUrl } = options.remoteUrl
        ? { remoteUrl: options.remoteUrl }
        : await inquirer.prompt([{
            type: 'input',
            name: 'remoteUrl',
            message: 'Git remote URL (leave empty for local-only):',
            default: '',
          }]);
      backendConfig.remoteUrl = remoteUrl;
      backendConfig.branch = 'main';
      break;
    }

    case 'cloud': {
      const availableClouds = env.cloudStoragePaths.filter(c => c.exists);
      let provider: CloudProvider;
      let cloudPath: string;

      if (options.cloudProvider) {
        provider = options.cloudProvider as CloudProvider;
        cloudPath = options.cloudPath ?? availableClouds.find(c => c.provider === provider)?.path ?? '';
      } else if (availableClouds.length === 1) {
        provider = availableClouds[0].provider;
        cloudPath = availableClouds[0].path;
        console.log(chalk.dim(`  Auto-detected: ${provider} at ${cloudPath}`));
      } else if (availableClouds.length > 1) {
        const answer = await inquirer.prompt([{
          type: 'list',
          name: 'provider',
          message: 'Which cloud storage?',
          choices: availableClouds.map(c => ({
            name: `${c.provider} (${c.path})`,
            value: c.provider,
          })),
        }]);
        provider = answer.provider;
        cloudPath = availableClouds.find(c => c.provider === provider)?.path ?? '';
      } else {
        const answer = await inquirer.prompt([
          {
            type: 'list',
            name: 'provider',
            message: 'Which cloud provider?',
            choices: ['dropbox', 'icloud', 'onedrive'],
          },
          {
            type: 'input',
            name: 'cloudPath',
            message: 'Path to cloud storage folder:',
          },
        ]);
        provider = answer.provider;
        cloudPath = answer.cloudPath;
      }

      backendConfig.cloudProvider = provider;
      backendConfig.cloudPath = cloudPath;
      break;
    }

    case 'gitea': {
      const giteaAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'giteaUrl',
          message: 'Gitea URL (e.g. https://gitea.yourserver.org or http://192.0.2.10:3000):',
          validate: (v: string) => v.startsWith('http') ? true : 'Must start with http:// or https://',
        },
        {
          type: 'input',
          name: 'giteaUser',
          message: 'Gitea username:',
          validate: (v: string) => v.length > 0 ? true : 'Required',
        },
        {
          type: 'password',
          name: 'giteaToken',
          message: 'Gitea personal access token (Settings → Applications → Access Tokens):',
          validate: (v: string) => v.length > 0 ? true : 'Required',
        },
        {
          type: 'input',
          name: 'giteaRepo',
          message: 'Repository name to use:',
          default: 'claude-memory',
        },
      ]);

      backendConfig.giteaUrl   = giteaAnswers.giteaUrl;
      backendConfig.giteaUser  = giteaAnswers.giteaUser;
      backendConfig.giteaToken = giteaAnswers.giteaToken;
      backendConfig.giteaRepo  = giteaAnswers.giteaRepo;
      backendConfig.branch     = 'main';

      // Test connection immediately
      console.log(chalk.dim('  Verifying connection to Gitea...'));
      const { GiteaBackend } = await import('../backends/gitea.js');
      const testBackend = new GiteaBackend(backendConfig);
      const check = await testBackend.validateConnection();
      if (!check.ok) {
        console.log(chalk.red(`  ✗ Cannot connect: ${check.error}`));
        console.log(chalk.dim('  Check URL and token, then run claude-sync init again.'));
        return;
      }
      console.log(chalk.green(`  ✓ Connected as @${check.user} — repo will be auto-created if needed`));
      break;
    }

    case 'syncthing': {
      // Syncthing auto-detects most settings
      break;
    }

    case 'rsync': {
      const { rsyncTarget } = options.rsyncTarget
        ? { rsyncTarget: options.rsyncTarget }
        : await inquirer.prompt([{
            type: 'input',
            name: 'rsyncTarget',
            message: 'rsync target (user@host:/path):',
          }]);

      backendConfig.rsyncTarget = rsyncTarget;
      backendConfig.sshKeyPath = options.sshKey;
      break;
    }

    case 'custom': {
      let pushCmd: string;
      let pullCmd: string;

      if (options.pushCmd && options.pullCmd) {
        pushCmd = options.pushCmd;
        pullCmd = options.pullCmd;
      } else {
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'pushCmd',
            message: 'Push command (use {path} for .claude/ path):',
          },
          {
            type: 'input',
            name: 'pullCmd',
            message: 'Pull command (use {path} for .claude/ path):',
          },
          {
            type: 'input',
            name: 'statusCmd',
            message: 'Status command (optional):',
            default: '',
          },
        ]);
        pushCmd = answers.pushCmd;
        pullCmd = answers.pullCmd;
        backendConfig.statusCommand = answers.statusCmd || undefined;
      }

      backendConfig.pushCommand = pushCmd;
      backendConfig.pullCommand = pullCmd;
      break;
    }
  }

  // ── Encryption ───────────────────────────────────────────────

  // Not offered until it actually encrypts synced files.
  if (options.encrypt) {
    console.log(chalk.yellow(`  ${ENCRYPTION_NOT_IMPLEMENTED}`));
    console.log('');
  }
  const encryptionConfig = { enabled: false };

  // ── Auto-sync ────────────────────────────────────────────────

  let autoSyncEnabled = options.autoSync ?? true;
  let watchEnabled = options.watch ?? true;

  if (options.autoSync === undefined) {
    const { autoSync } = await inquirer.prompt([{
      type: 'confirm',
      name: 'autoSync',
      message: 'Auto-sync on session start/end?',
      default: true,
    }]);
    autoSyncEnabled = autoSync;
  }

  if (options.watch === undefined && autoSyncEnabled) {
    const { watch } = await inquirer.prompt([{
      type: 'confirm',
      name: 'watch',
      message: 'Watch for changes in real-time?',
      default: true,
    }]);
    watchEnabled = watch;
  }

  // ── Save Configuration ───────────────────────────────────────

  const registry = new DeviceRegistry();
  const device = registry.getCurrentDevice(deviceName);

  const config: SyncConfig = {
    version: 1,
    deviceId: device.id,
    deviceName,
    backend: backendConfig,
    encryption: encryptionConfig,
    autoSync: {
      onSessionStart: autoSyncEnabled,
      onSessionEnd: autoSyncEnabled,
      watchEnabled,
      watchDebounceMs: 2000,
    },
    selective: {
      mode: 'all',
      include: [],
      exclude: [],
    },
    hooks: {},
  };

  await fs.mkdir(configDir, { recursive: true });
  await writeFileAtomic(configFile, JSON.stringify(config, null, 2));

  // Register this device
  await registry.registerDevice(device);

  // ── Initialize Backend ───────────────────────────────────────

  console.log('');
  console.log(chalk.dim('  Initializing sync backend...'));

  try {
    const backend = getBackend(backendConfig);
    await backend.init(backendConfig);
    console.log(chalk.green('  Backend initialized.'));
  } catch (err) {
    console.log(chalk.yellow(`  Backend setup warning: ${(err as Error).message}`));
    console.log(chalk.dim('  You may need to complete setup manually.'));
  }

  // ── Success ──────────────────────────────────────────────────

  console.log('');
  console.log(chalk.green.bold('  Setup complete!'));
  console.log('');
  console.log(`  ${chalk.dim('Device:')}     ${deviceName}`);
  console.log(`  ${chalk.dim('Backend:')}    ${formatBackend(backendConfig)}`);
  console.log(`  ${chalk.dim('Encryption:')} not implemented yet`);
  console.log(`  ${chalk.dim('Auto-sync:')}  ${autoSyncEnabled ? 'enabled' : 'disabled'}`);
  console.log(`  ${chalk.dim('Watcher:')}    ${watchEnabled ? 'enabled' : 'disabled'}`);
  console.log('');
  console.log(chalk.dim("  Run 'claude-sync status' to check sync state."));
  console.log(chalk.dim("  Run 'claude-sync sync' to sync now."));
  console.log('');
}

function formatBackend(config: BackendConfig): string {
  switch (config.type) {
    case 'git':
      return config.remoteUrl ? `git (${config.remoteUrl})` : 'git (local)';
    case 'gitea':
      return `gitea (${config.giteaUrl}/${config.giteaUser}/${config.giteaRepo ?? 'claude-memory'})`;
    case 'cloud':
      return `${config.cloudProvider} (${config.cloudPath})`;
    case 'syncthing':
      return 'syncthing (P2P)';
    case 'rsync':
      return `rsync (${config.rsyncTarget})`;
    case 'custom':
      return 'custom command';
    default:
      return config.type;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
